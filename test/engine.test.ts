/**
 * AudioEngine 图行为测试：使用最小 Web Audio 模拟（无真实音频设备）。
 * 验证：
 *  - 解锁后构建输出链；声轨经过 HRTF PannerNode
 *  - 静音 → trackGain=0；独奏 → 非独奏声轨被切到 muteBus（真实不可闻）
 *  - 移动声源只改变 position AudioParam，不重建 source（不重启音轨）
 *  - 总线/主增益真实进入链路
 *  - 峰值 worklet 不可用时不致命（回退表）
 *  - 解码失败以 DecodeError 单独抛出
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

// ---------- 最小 Web Audio 模拟 ----------

class FakeAudioParam {
  value: number;
  events: { time: number; value: number; tc: number }[] = [];
  curves: { time: number; data: Float32Array; duration: number }[] = [];
  constructor(v: number) {
    this.value = v;
  }
  setTargetAtTime(v: number, time: number, tc: number) {
    this.value = v;
    this.events.push({ time, value: v, tc });
  }
  setValueAtTime(v: number, _time?: number) {
    this.value = v;
  }
  linearRampToValueAtTime(v: number, _time?: number) {
    this.value = v;
  }
  setValueCurveAtTime(data: Float32Array, time: number, duration: number) {
    this.curves.push({ time, data, duration });
    this.value = data[0];
  }
  cancelScheduledValues(_time: number) {
    this.curves = [];
  }
}

class FakeNode {
  connects: { node: FakeNode; out?: number; inp?: number }[] = [];
  disconnected = false;
  connectedFrom: FakeNode[] = [];
  connect(node: FakeNode | { input?: FakeNode }, out?: number, inp?: number): FakeNode {
    const target = (node as { input?: FakeNode }).input ?? (node as FakeNode);
    this.connects.push({ node: target, out, inp });
    target.connectedFrom.push(this);
    return target;
  }
  disconnect() {
    this.connects = [];
    this.disconnected = true;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeAudioParam(1);
}
class FakeStereoPanner extends FakeNode {}
class FakeDestination extends FakeNode {}

class FakePanner extends FakeNode {
  panningModel = 'HRTF';
  distanceModel: DistanceModelStr = 'inverse';
  refDistance = 1;
  rolloffFactor = 1;
  maxDistance = 100;
  positionX = new FakeAudioParam(0);
  positionY = new FakeAudioParam(0);
  positionZ = new FakeAudioParam(0);
  positionTimeConstant = 0;
  orientationX = new FakeAudioParam(1);
  constructor(_ctx: unknown, opts: Record<string, unknown> = {}) {
    super();
    Object.assign(this, opts);
    if (opts.positionX !== undefined) this.positionX = new FakeAudioParam(opts.positionX as number);
    if (opts.positionY !== undefined) this.positionY = new FakeAudioParam(opts.positionY as number);
    if (opts.positionZ !== undefined) this.positionZ = new FakeAudioParam(opts.positionZ as number);
  }
}
type DistanceModelStr = 'linear' | 'inverse' | 'exponential';

class FakeBufferSource extends FakeNode {
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  started: { time: number; offset: number; duration?: number }[] = [];
  /** 无参/即时 stop 次数（强停）；stop(未来时刻) 为预定停止，单独计数 */
  stopped = 0;
  scheduledStops: number[] = [];
  onended: (() => void) | null = null;
  start(time: number, offset = 0, duration?: number) {
    this.started.push({ time, offset, duration });
  }
  stop(time?: number) {
    if (time == null) this.stopped++;
    else this.scheduledStops.push(time);
  }
}

class FakeBuffer {
  duration: number;
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  private data: Float32Array[];
  constructor(ch: number, length: number, sr: number, duration: number) {
    this.numberOfChannels = ch;
    this.length = length;
    this.sampleRate = sr;
    this.duration = duration;
    this.data = Array.from({ length: ch }, () => new Float32Array(length));
  }
  getChannelData(i: number) {
    return this.data[i];
  }
}
type FakeAudioBuffer = FakeBuffer;

class FakeSplitter extends FakeNode {
  constructor(public channels: number) {
    super();
  }
}
class FakeMerger extends FakeNode {}

class FakeListener {
  positionX = new FakeAudioParam(0);
  positionY = new FakeAudioParam(0);
  positionZ = new FakeAudioParam(0);
  forwardX = new FakeAudioParam(0);
  forwardY = new FakeAudioParam(0);
  forwardZ = new FakeAudioParam(-1);
  upX = new FakeAudioParam(0);
  upY = new FakeAudioParam(1);
  upZ = new FakeAudioParam(0);
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  getFloatTimeDomainData(arr: Float32Array) {
    arr.fill(0);
  }
}

class FakeAudioContext {
  state: 'running' | 'suspended' = 'running';
  currentTime = 0;
  playbackRate = { value: 1 };
  destination = new FakeDestination();
  listener = new FakeListener();
  sampleRate = 48000;
  audioWorklet = {
    addModule: async () => {
      throw new Error('worklet unavailable in test');
    },
  };
  createGain() {
    return new FakeGain();
  }
  createBufferSource() {
    return new FakeBufferSource();
  }
  createBuffer(ch: number, length: number, sr: number) {
    return new FakeBuffer(ch, length, sr, length / sr);
  }
  createChannelSplitter(ch: number) {
    return new FakeSplitter(ch);
  }
  createChannelMerger(ch: number) {
    void ch;
    return new FakeMerger();
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  createStereoPanner() {
    return new FakeStereoPanner();
  }
  async resume() {
    this.state = 'running';
  }
  async decodeAudioData(buf: ArrayBuffer): Promise<FakeBuffer> {
    const text = new TextDecoder().decode(buf);
    if (text === 'BAD') throw new Error('EncodingError: fake bad file');
    return new FakeBuffer(1, 48000, 48000, 1);
  }
  async close() {}
}

const g = globalThis as unknown as Record<string, unknown>;
g.AudioContext = FakeAudioContext;
g.requestAnimationFrame = (fn: FrameRequestCallback) => {
  return setTimeout(() => fn(0), 16) as unknown as number;
};
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.window = globalThis;
g.PannerNode = FakePanner;

const { AudioEngine, ClipError, DecodeError } = await import('../src/lib/audioEngine.ts');
const { createSampleBuffer } = await import('../src/lib/samples.ts');

function baseTrack(over: Partial<import('../src/types.ts').Track> = {}) {
  return {
    id: 't1',
    name: 'T',
    sourceType: 'tone' as const,
    loop: false,
    muted: false,
    solo: false,
    gain: 0.8,
    channel: 0,
    color: '#fff',
    position: { x: 2, y: 0, z: 0 },
    status: 'pending' as const,
    clips: [],
    activeClipId: null,
    ...over,
  };
}

describe('AudioEngine 图行为（模拟环境）', () => {
  let engine: InstanceType<typeof AudioEngine>;

  beforeEach(() => {
    engine = new AudioEngine();
  });

  afterEach(() => {
    engine.dispose();
  });

  it('resume 解锁；setListener 写入与空间数学一致的朝向', async () => {
    await engine.resume();
    assert.equal(engine.unlock, 'unlocked');
    engine.setListener({
      position: { x: 0, y: 0, z: 3 },
      yaw: Math.PI / 2, // 右转 → forward (+1,0,0)
      pitch: 0,
      earHeight: 0,
    });
    const li = engine.ctx!.listener as unknown as FakeListener;
    assert.ok(Math.abs(li.forwardX.value - 1) < 1e-6);
    assert.ok(Math.abs(li.forwardZ.value) < 1e-6);
    assert.ok(Math.abs(li.upY.value - 1) < 1e-6);
    assert.ok(Math.abs(li.positionZ.value - 3) < 1e-6);
  });

  it('声轨链路为 source→trackGain→HRTF panner→soloBus→…→destination；距离模型参数下发', async () => {
    await engine.resume();
    engine.setSpatialSettings({
      distanceModel: 'exponential',
      refDistance: 2,
      rolloffFactor: 1.5,
      maxDistance: 25,
      positionTimeConstant: 0.05,
      hrtfIR: 'none',
    });
    const track = baseTrack();
    await engine.ensureTrack(track);
    const voices = (engine as unknown as { voices: Map<string, { panner: FakePanner; trackGain: FakeGain; clipGain: FakeGain; source: FakeBufferSource }> }).voices;
    const v = voices.get('t1')!;
    assert.equal(v.panner.panningModel, 'HRTF');
    assert.equal(v.panner.distanceModel, 'exponential');
    assert.equal(v.panner.refDistance, 2);
    assert.equal(v.panner.rolloffFactor, 1.5);
    assert.equal(v.panner.maxDistance, 25);
    assert.ok(Math.abs(v.panner.positionX.value - 2) < 1e-9);
    // source → gain → clipGain（片段淡化汇入点）→ panner
    assert.ok(v.source.connects.some((c) => c.node === v.trackGain));
    assert.ok(v.trackGain.connects.some((c) => c.node === v.clipGain));
    assert.ok(v.clipGain.connects.some((c) => c.node === v.panner));
    // panner → soloBus
    const soloBus = (engine as unknown as { soloBus: FakeGain }).soloBus;
    assert.ok(v.panner.connects.some((c) => c.node === soloBus));
  });

  it('静音真实把 trackGain 置 0；独奏把非独奏声轨切到 muteBus', async () => {
    await engine.resume();
    const a = baseTrack({ id: 'a' });
    const b = baseTrack({ id: 'b', position: { x: -2, y: 0, z: 0 } });
    await engine.ensureTrack(a);
    await engine.ensureTrack(b);
    const voices = (engine as unknown as {
      voices: Map<string, { trackGain: FakeGain; panner: FakePanner }>;
      muteBus: FakeGain;
    }).voices;
    const muteBus = (engine as unknown as { muteBus: FakeGain }).muteBus;

    engine.syncTracks([{ ...a, muted: true }, b]);
    assert.equal(voices.get('a')!.trackGain.gain.value, 0);
    assert.equal(voices.get('b')!.trackGain.gain.value, 0.8);

    engine.syncTracks([{ ...a, muted: true }, { ...b, solo: true }]);
    // a 既静音又非独奏 → muteBus；b 独奏 → 留在可闻总线
    assert.ok(voices.get('a')!.panner.connects.some((c) => c.node === muteBus));
    assert.ok(
      voices.get('b')!.panner.connects.every((c) => c.node !== muteBus),
    );

    // 解除独奏后，a 仍因 muted 留在 muteBus，b 回到 soloBus
    engine.syncTracks([{ ...a, muted: true }, b]);
    assert.ok(voices.get('a')!.panner.connects.some((c) => c.node === muteBus));
    assert.ok(
      voices.get('a')!.panner.connects.every((c) => c.node === muteBus),
    );
  });

  it('移动声源只写 AudioParam，绝不 stop/start source（不重启音轨）', async () => {
    await engine.resume();
    const t = baseTrack();
    await engine.playTrack(t);
    const v = (engine as unknown as {
      voices: Map<string, { source: FakeBufferSource; panner: FakePanner }>;
    }).voices.get('t1')!;
    const startsBefore = v.source.started.length;
    const stopsBefore = v.source.stopped;

    for (let i = 0; i < 10; i++) {
      engine.syncTracks([
        { ...t, position: { x: 2 + i * 0.1, y: 0.5, z: -i * 0.2 } },
      ]);
    }
    assert.ok(Math.abs(v.panner.positionX.value - 2.9) < 1e-9);
    assert.ok(Math.abs(v.panner.positionY.value - 0.5) < 1e-9);
    assert.ok(Math.abs(v.panner.positionZ.value - -1.8) < 1e-9);
    assert.equal(v.source.started.length, startsBefore);
    assert.equal(v.source.stopped, stopsBefore);
  });

  it('暂停会停止并重建节点且保留偏移；再次播放从偏移开始', async () => {
    await engine.resume();
    const ctx = engine.ctx as unknown as FakeAudioContext;
    const t = { ...baseTrack(), loop: false };
    await engine.playTrack(t);
    ctx.currentTime = 0.3;
    engine.pauseTrack(t);
    await engine.playTrack({ ...t });
    const v = (engine as unknown as {
      voices: Map<string, { source: FakeBufferSource; offset: number }>;
    }).voices.get('t1')!;
    // 最新一次 start 的 offset ≈ 0.3
    const last = v.source.started[v.source.started.length - 1];
    assert.ok(Math.abs(last.offset - 0.3) < 1e-6);
  });

  it('总线与主增益真实写入对应 GainNode', async () => {
    await engine.resume();
    engine.setBusGain(0.42);
    engine.setMasterGain(0.71);
    const bus = (engine as unknown as { busGain: FakeGain }).busGain;
    const master = (engine as unknown as { masterGain: FakeGain }).masterGain;
    assert.ok(Math.abs(bus.gain.value - 0.42) < 1e-9);
    assert.ok(Math.abs(master.gain.value - 0.71) < 1e-9);
    // 主输出确实连向 destination（master → analyser → destination，worklet 不可用时）
    const analyser = (engine as unknown as { analyser: FakeAnalyser }).analyser;
    const destination = (engine.ctx as unknown as FakeAudioContext).destination;
    assert.ok(analyser.connects.some((c) => c.node === destination));
  });

  it('坏文件解码失败抛出 DecodeError，且不影响其他声轨', async () => {
    await engine.resume();
    const bad = baseTrack({ id: 'bad', sourceType: 'file' as const });
    engine.setFileBlob('bad', new Blob([new TextEncoder().encode('BAD')], { type: 'audio/x' }));
    await assert.rejects(engine.ensureTrack(bad), (err: unknown) => err instanceof DecodeError);

    const good = baseTrack({ id: 'good' });
    await engine.ensureTrack(good);
    const voices = (engine as unknown as { voices: Map<string, unknown> }).voices;
    assert.ok(voices.has('good'));
  });

  it('内置样例缓冲可经引擎合成，时长与声道符合预期', async () => {
    await engine.resume();
    const buf = createSampleBuffer(engine.ctx as unknown as BaseAudioContext, 'pulse');
    assert.equal(buf.numberOfChannels, 1);
    assert.ok(Math.abs(buf.duration - 1.6) < 1e-6);
  });
});

// ---------- 非破坏性片段播放 ----------

function makeClip(over: Partial<import('../src/types.ts').Clip> = {}) {
  return {
    id: 'clip1',
    name: '片段',
    trackId: 't1',
    inPoint: 0.5,
    outPoint: 2,
    fadeIn: { length: 0.05, curve: 'linear' as const },
    fadeOut: { length: 0.1, curve: 'equalPower' as const },
    loop: { enabled: false, inPoint: 0.5, outPoint: 2 },
    sourceDuration: 3, // tone 样例时长
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function clipInternals(eng: InstanceType<typeof AudioEngine>) {
  return eng as unknown as {
    clipPlays: Map<
      string,
      {
        clipId: string;
        stream: {
          clip: unknown;
          slices: {
            source: FakeBufferSource;
            sliceGain: FakeGain;
            startAt: number;
            endAt: number;
            localStart: number;
            localEnd: number;
          }[];
          cursor: number;
          finished: boolean;
        } | null;
        armed: unknown;
        boundary: number | null;
        outgoing: { source: FakeBufferSource; endAt: number; startAt: number }[];
      }
    >;
    voices: Map<
      string,
      { source: FakeBufferSource; clipGain: FakeGain; trackGain: FakeGain; panner: FakePanner; playing: boolean }
    >;
  };
}

describe('AudioEngine 非破坏性片段', () => {
  let eng: InstanceType<typeof AudioEngine>;
  const ctxNow = (t: number) => {
    (eng.ctx as unknown as FakeAudioContext).currentTime = t;
  };

  beforeEach(async () => {
    eng = new AudioEngine();
    await eng.resume();
  });
  afterEach(() => eng.dispose());

  it('片段只引用原始区间：源以 inPoint/长度起播，淡化节点真实串在 panner 前', async () => {
    const c = makeClip();
    const track = baseTrack({ clips: [c], activeClipId: 'clip1' });
    await eng.playClip(track, c);
    eng.pumpScheduler();
    const ie = clipInternals(eng);
    const play = ie.clipPlays.get('t1')!;
    assert.ok(play.stream);
    assert.equal(play.stream.slices.length, 1);
    const s0 = play.stream.slices[0];
    assert.deepEqual(
      s0.source.started[s0.source.started.length - 1],
      { time: 0, offset: 0.5, duration: 1.5 },
    );
    // 淡化包络真实写入本段增益（96 点曲线），段增益 → voice.clipGain → panner
    assert.ok(s0.sliceGain.gain.curves.length >= 1);
    assert.ok(s0.sliceGain.connects.some((cn) => cn.node === ie.voices.get('t1')!.clipGain));
    assert.ok(ie.voices.get('t1')!.clipGain.connects.some((cn) => cn.node === ie.voices.get('t1')!.panner));
  });

  it('两条同步样例的不同片段在同一 ctx 时钟上调度且各自无缝（无间隙）', async () => {
    const ca = makeClip({
      id: 'a',
      trackId: 'a',
      inPoint: 0.5,
      outPoint: 3,
      loop: { enabled: true, inPoint: 1, outPoint: 3 },
      sourceDuration: 4,
    });
    const cb = makeClip({
      id: 'b',
      trackId: 'b',
      inPoint: 1,
      outPoint: 2.5,
      loop: { enabled: true, inPoint: 1.2, outPoint: 2.2 },
      sourceDuration: 4,
    });
    const ta = baseTrack({ id: 'a', sourceType: 'duoA' as const, clips: [ca], activeClipId: 'a' });
    const tb = baseTrack({ id: 'b', sourceType: 'duoB' as const, clips: [cb], activeClipId: 'b' });
    await eng.playClip(ta, ca);
    await eng.playClip(tb, cb);
    eng.pumpScheduler();
    const ie = clipInternals(eng);
    const sa = ie.clipPlays.get('a')!.stream!.slices;
    const sb = ie.clipPlays.get('b')!.stream!.slices;
    // 同一时钟：两轨首段都在 0 起播
    assert.equal(sa[0].startAt, 0);
    assert.equal(sb[0].startAt, 0);
    // 每轨相邻段首尾相接（无间隙/重叠），闭式排程时间精确
    for (const slices of [sa, sb]) {
      for (let i = 1; i < slices.length; i++) {
        assert.ok(Math.abs(slices[i].startAt - slices[i - 1].endAt) < 1e-12);
      }
    }
    // A：首段长 2.5，循环体长 2；推进很多圈后边界仍是精确整数倍（无漂移）
    const aLater = sa[sa.length - 1];
    assert.ok(Math.abs(aLater.endAt - (2.5 + (sa.length - 1) * 2)) < 1e-9);
    // 段偏移映射正确：循环段从 loopIn 起播
    assert.ok(Math.abs(sa[1].source.started[0].offset - 1) < 1e-12);
    assert.ok(Math.abs(sb[1].source.started[0].offset - 1.2) < 1e-12);
  });

  it('播放中修改片段：旧源不被强停，新源在安全边界同点起播，不双播、不重启无关轨', async () => {
    const c = makeClip(); // 非循环 0.5–2.0，首段结束于 1.5s
    const track = baseTrack({ clips: [c], activeClipId: 'clip1' });
    await eng.playClip(track, c);
    eng.pumpScheduler();
    const ie = clipInternals(eng);
    const oldSource = ie.clipPlays.get('t1')!.stream!.slices[0].source;

    // 另一条无关轨正在整轨播放
    const t2 = baseTrack({ id: 'x', position: { x: -1, y: 0, z: 0 } });
    await eng.playTrack(t2);
    const xSource = clipInternals(eng).voices.get('x')!.source;
    const xStarts = xSource.started.length;

    const c2 = makeClip({ id: 'clip1', inPoint: 0, outPoint: 1, sourceDuration: 3, version: 2 });
    // 边界（1.5s）尚远：换流挂起（armed），仍是旧流发声，没有新源被创建
    eng.armClip('t1', c2);
    eng.pumpScheduler();
    assert.equal(oldSource.stopped, 0); // 绝不强停正在发声的源
    assert.equal(ie.clipPlays.get('t1')!.stream!.slices[0].source, oldSource);
    const allSources = () =>
      [...ie.clipPlays].flatMap(([, p]) => [
        ...(p.stream?.slices ?? []),
        ...(p.outgoing ?? []),
      ]);
    assert.equal(allSources().filter((s) => s.source !== oldSource).length, 0);

    ctxNow(1.3); // 距边界 0.2s：在安全边界建并预排新流（源 start(1.5)），旧段移入 outgoing
    eng.pumpScheduler();
    const play = ie.clipPlays.get('t1')!;
    assert.equal(play.armed, null);
    assert.equal(play.boundary, null);
    assert.equal(play.outgoing.length, 1); // 旧段保留到边界自然结束
    const ns = play.stream!.slices[0];
    assert.ok(Math.abs(ns.startAt - 1.5) < 1e-9); // 与旧段结束同点
    assert.deepEqual(ns.source.started[0], { time: 1.5, offset: 0, duration: 1 });
    assert.equal(oldSource.stopped, 0); // 旧源由其自身 stop 时刻自然结束
    // 无关轨未被重启
    assert.equal(xSource.started.length, xStarts);
    assert.equal(xSource.stopped, 0);

    ctxNow(1.5);
    eng.pumpScheduler();
    // 边界时刻：旧段在 outgoing（刚好结束，不被强停）；新流只有一个源——无双重播放
    assert.equal(play.stream!.slices.length, 1);
    assert.equal(play.outgoing.length, 1);
    assert.equal(play.outgoing[0].source, oldSource);
    // 旧段与新段在边界上首尾相接（同一时钟、无间隙）
    assert.ok(Math.abs(play.outgoing[0].endAt - play.stream!.slices[0].startAt) < 1e-12);

    ctxNow(2.0);
    eng.pumpScheduler();
    // 旧段已自然回收；新流独立播放
    assert.equal(play.outgoing.length, 0);
    assert.equal(play.stream!.slices[0].source, ns.source);
  });

  it('边界很远时换流挂起：旧流继续无缝续排，不越过边界排段，到边界才换新流', async () => {
    // 循环片段：首遍 0.2–2.6（长 2.4），循环体 1–2.6（每圈 1.6s）；tone 样例 3s
    const c = makeClip({
      inPoint: 0.2,
      outPoint: 2.6,
      loop: { enabled: true, inPoint: 1, outPoint: 2.6 },
      sourceDuration: 3,
    });
    const track = baseTrack({ clips: [c], activeClipId: 'clip1' });
    await eng.playClip(track, c);
    eng.pumpScheduler();
    const ie = clipInternals(eng);
    const old = ie.clipPlays.get('t1')!;
    // 立即挂起一个边界很远的换流
    const c2 = makeClip({ id: 'clip1', inPoint: 0, outPoint: 0.5, sourceDuration: 3, version: 2 });
    eng.armClip('t1', c2);
    const armedAt = (ie.clipPlays.get('t1') as unknown as { boundary: number }).boundary;
    // 边界 = 当前发声段（首遍）结束 2.4s；旧流仍未 finished，继续补排
    assert.ok(Math.abs(armedAt - 2.4) < 1e-9);
    assert.equal(old.stream!.finished, false);
    // 旧流没有任何段越过 2.4s 边界（杜绝边界后双重播放）
    for (const s of old.stream!.slices) assert.ok(s.endAt <= 2.4 + 1e-9);
    // 但至少排到了边界（到边界前无缝）
    assert.ok(old.stream!.slices.some((s) => Math.abs(s.endAt - 2.4) < 1e-9));

    // 边界前一刻仍是旧流，没有新源
    ctxNow(2.0);
    eng.pumpScheduler();
    const beforeSwitch = ie.clipPlays.get('t1')!;
    assert.notEqual(beforeSwitch.armed, null);

    // 进入 0.3s 窗口：换到边界起播的新流
    ctxNow(2.15);
    eng.pumpScheduler();
    const atSwitch = ie.clipPlays.get('t1')!;
    assert.equal(atSwitch.armed, null);
    assert.ok(Math.abs(atSwitch.stream!.slices[0].startAt - 2.4) < 1e-9);
    assert.deepEqual(atSwitch.stream!.slices[0].source.started[0], {
      time: 2.4,
      offset: 0,
      duration: 0.5,
    });
    // 旧首段保留在 outgoing 到 2.4 自然结束；边界后没有旧循环段
    assert.equal(atSwitch.outgoing.length, 1);
    assert.ok(Math.abs(atSwitch.outgoing[0].endAt - 2.4) < 1e-9);
  });

  it('非法边界在播放中提交被拒绝（ClipValidationError），播放继续旧描述', async () => {
    const c = makeClip();
    const track = baseTrack({ clips: [c], activeClipId: 'clip1' });
    await eng.playClip(track, c);
    eng.pumpScheduler();
    const bad = makeClip({ inPoint: 2.5, outPoint: 2.6, sourceDuration: 3 }); // 越过 3? 否：交叉淡化 0.05+0.1=0.15>0.1
    assert.throws(() => eng.armClip('t1', bad));
    const oor = makeClip({ inPoint: 2.9, outPoint: 4, sourceDuration: 3 });
    assert.throws(() => eng.armClip('t1', oor));
    // 旧流未受影响
    const s = clipInternals(eng).clipPlays.get('t1')!.stream!.slices[0];
    assert.deepEqual(s.source.started[0], { time: 0, offset: 0.5, duration: 1.5 });
  });

  it('原文件时长变化、解码失败、Blob 缺失分别报错，且不启动任何片段源', async () => {
    // 时长变化
    const changed = makeClip({ sourceDuration: 2.9 });
    const tChanged = baseTrack({ clips: [changed] });
    await assert.rejects(
      eng.playClip(tChanged, changed),
      (e: unknown) => e instanceof ClipError && /时长已变化/.test(e.message),
    );
    assert.equal(clipInternals(eng).clipPlays.has('t1'), false);

    // 解码失败（坏文件）→ DecodeError
    const bad = baseTrack({
      id: 'bad',
      sourceType: 'file' as const,
      clips: [makeClip({ trackId: 'bad' })],
    });
    eng.setFileBlob('bad', new Blob([new TextEncoder().encode('BAD')], { type: 'audio/x' }));
    await assert.rejects(eng.playClip(bad, makeClip({ trackId: 'bad' })), (e: unknown) => e instanceof DecodeError);

    // Blob 从未注入：不静音假成功，报“尚未就绪/解码失败”
    const missing = baseTrack({
      id: 'miss',
      sourceType: 'file' as const,
      status: 'decode-error' as const,
      errorMessage: '本地音频 Blob 缺失',
      clips: [makeClip({ trackId: 'miss' })],
    });
    await assert.rejects(
      eng.playClip(missing, makeClip({ trackId: 'miss' })),
      (e: unknown) => e instanceof ClipError && /解码失败/.test(e.message),
    );
  });

  it('暂停保留片段本地位置，恢复从同位置续播（偏移=入点+本地位置）', async () => {
    const c = makeClip();
    const track = baseTrack({ clips: [c], activeClipId: 'clip1' });
    await eng.playTrack(track); // 活动片段 → playClip
    eng.pumpScheduler();
    ctxNow(0.4);
    eng.pauseTrack(track); // → pauseClip
    const ie = clipInternals(eng);
    assert.equal(ie.clipPlays.get('t1')!.stream, null);
    await eng.playTrack(track); // → resumeClip
    const s = ie.clipPlays.get('t1')!.stream!.slices[0];
    assert.ok(Math.abs(s.source.started[0].offset - 0.9) < 1e-9); // 0.5 + 0.4
    assert.ok(Math.abs(s.source.started[0].duration! - 1.1) < 1e-9); // 1.5 - 0.4
  });

  it('非循环片段自然结束后片段播放记录清除、playing 归位', async () => {
    const c = makeClip();
    const track = baseTrack({ clips: [c], activeClipId: 'clip1' });
    await eng.playClip(track, c);
    eng.pumpScheduler();
    ctxNow(2.0);
    eng.pumpScheduler();
    assert.equal(clipInternals(eng).clipPlays.has('t1'), false);
    assert.equal(eng.isPlaying('t1'), false);
  });
});
