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
  curves: { values: Float32Array; time: number; duration: number }[] = [];
  ramps: { value: number; time: number }[] = [];
  constructor(v: number) {
    this.value = v;
  }
  setTargetAtTime(v: number, time: number, tc: number) {
    this.value = v;
    this.events.push({ time, value: v, tc });
  }
  setValueAtTime(v: number, time: number) {
    this.value = v;
    this.events.push({ time, value: v, tc: 0 });
  }
  setValueCurveAtTime(values: Float32Array, time: number, duration: number) {
    this.curves.push({ values, time, duration });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.ramps.push({ value, time });
    return this;
  }
  cancelScheduledValues(_time: number) {
    this.curves = [];
    this.ramps = [];
    return this;
  }
  cancelAndHoldAtTime(time: number) {
    return this.cancelScheduledValues(time);
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
  loopStart = 0;
  loopEnd = 0;
  started: { time: number; offset: number; duration?: number }[] = [];
  stopped: { time: number | undefined }[] = [];
  onended: (() => void) | null = null;
  start(time: number, offset = 0, duration?: number) {
    this.started.push({ time, offset, duration });
  }
  stop(time?: number) {
    this.stopped.push({ time });
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
  }  async close() {}
}

const g = globalThis as unknown as Record<string, unknown>;
g.AudioContext = FakeAudioContext;
g.requestAnimationFrame = (fn: FrameRequestCallback) => {
  return setTimeout(() => fn(0), 16) as unknown as number;
};
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.window = globalThis;
g.PannerNode = FakePanner;

const { AudioEngine, DecodeError } = await import('../src/lib/audioEngine.ts');
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
    const voices = (engine as unknown as { voices: Map<string, { panner: FakePanner; trackGain: FakeGain; source: FakeBufferSource }> }).voices;
    const v = voices.get('t1')!;
    assert.equal(v.panner.panningModel, 'HRTF');
    assert.equal(v.panner.distanceModel, 'exponential');
    assert.equal(v.panner.refDistance, 2);
    assert.equal(v.panner.rolloffFactor, 1.5);
    assert.equal(v.panner.maxDistance, 25);
    assert.ok(Math.abs(v.panner.positionX.value - 2) < 1e-9);
    // source → gain
    assert.ok(v.source.connects.some((c) => c.node === v.trackGain));
    // gain → panner
    assert.ok(v.trackGain.connects.some((c) => c.node === v.panner));
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
    const stopsBefore = 0;

    for (let i = 0; i < 10; i++) {
      engine.syncTracks([
        { ...t, position: { x: 2 + i * 0.1, y: 0.5, z: -i * 0.2 } },
      ]);
    }
    assert.ok(Math.abs(v.panner.positionX.value - 2.9) < 1e-9);
    assert.ok(Math.abs(v.panner.positionY.value - 0.5) < 1e-9);
    assert.ok(Math.abs(v.panner.positionZ.value - -1.8) < 1e-9);
    assert.equal(v.source.started.length, startsBefore);
    assert.equal(v.source.stopped.length, stopsBefore);
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

// ---------- 非破坏性片段 ----------

import {
  ClipHistory,
  clipFadeGain,
  clipTimelineLifespan,
  mapTimelineToSource,
  validateClipFields,
  ClipValidationError,
} from '../src/lib/clipEdit.ts';
import { ClipPlayError } from '../src/lib/audioEngine.ts';
import type { Clip } from '../src/types.ts';

function makeClip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't1',
    name: 'clip',
    color: '#fff',
    sourceStart: 0,
    sourceEnd: 1,
    fadeIn: { duration: 0, shape: 'linear' },
    fadeOut: { duration: 0, shape: 'linear' },
    loop: { enabled: false, start: 0, count: Number.POSITIVE_INFINITY },
    revision: 1,
    sourceDuration: 1,
    createdAt: 0,
    ...over,
  };
}

const fieldsOf = (c: Clip) => ({
  sourceStart: c.sourceStart,
  sourceEnd: c.sourceEnd,
  fadeIn: c.fadeIn,
  fadeOut: c.fadeOut,
  loop: c.loop,
});

describe('片段纯逻辑：校验/淡化/时间线/撤销', () => {
  it('入点/出点越界被拒绝；淡化重叠（不可解释交叉淡化）被拒绝', () => {
    assert.throws(
      () => validateClipFields(fieldsOf(makeClip({ sourceStart: -0.01, sourceEnd: 1 })), 1),
      ClipValidationError,
    );
    assert.throws(
      () => validateClipFields(fieldsOf(makeClip({ sourceStart: 0, sourceEnd: 1.0001 })), 1),
      ClipValidationError,
    );
    assert.throws(
      () =>
        validateClipFields(
          fieldsOf(
            makeClip({
              fadeIn: { duration: 0.6, shape: 'linear' },
              fadeOut: { duration: 0.6, shape: 'linear' },
            }),
          ),
          1,
        ),
      /重叠/,
    );
    // 循环点越界
    assert.throws(
      () =>
        validateClipFields(
          fieldsOf(makeClip({ loop: { enabled: true, start: 1, count: Number.POSITIVE_INFINITY } })),
          1,
        ),
      /循环回跳点/,
    );
    // 持续循环 + 淡出 不允许
    assert.throws(
      () =>
        validateClipFields(
          fieldsOf(
            makeClip({
              fadeOut: { duration: 0.1, shape: 'linear' },
              loop: { enabled: true, start: 0.2, count: Number.POSITIVE_INFINITY },
            }),
          ),
          1,
        ),
      /持续循环/,
    );
  });

  it('淡化曲线在端点为 0/1，等功率中点≈-3dB', () => {
    const c = makeClip({
      sourceEnd: 1,
      fadeIn: { duration: 0.4, shape: 'equalPower' },
      fadeOut: { duration: 0.4, shape: 'linear' },
    });
    assert.ok(Math.abs(clipFadeGain(c, 0)) < 1e-9);
    assert.ok(Math.abs(clipFadeGain(c, 0.2) - Math.SQRT1_2) < 1e-6);
    assert.ok(Math.abs(clipFadeGain(c, 0.5) - 1) < 1e-9);
    assert.ok(Math.abs(clipFadeGain(c, 0.8) - 0.5) < 1e-6);
    assert.ok(Math.abs(clipFadeGain(c, 1 - 1e-7)) < 1e-4);
  });

  it('时间线→原始时间：无循环线性；循环按回跳点与次数环绕并结束', () => {
    const c = makeClip({
      sourceStart: 1,
      sourceEnd: 2,
      loop: { enabled: true, start: 1.5, count: 2 },
    });
    assert.deepEqual(mapTimelineToSource(c, 0), { offset: 1, ended: false });
    assert.deepEqual(mapTimelineToSource(c, 0.4), { offset: 1.4, ended: false });
    // 进入循环：0.5 -> 1.5， 0.6 -> 1.6
    assert.deepEqual(mapTimelineToSource(c, 0.5), { offset: 1.5, ended: false });
    assert.deepEqual(mapTimelineToSource(c, 0.99), { offset: 1.99, ended: false });
    // 寿命 = 0.5(前导) + 0.5*2 = 1.5
    assert.ok(Math.abs(clipTimelineLifespan(c) - 1.5) < 1e-9);
    const end = mapTimelineToSource(c, 1.5);
    assert.equal(end!.ended, true);
  });

  it('撤销/恢复只换编辑描述且数值精确、重复操作不累积误差', () => {
    const initial = makeClip();
    const h = new ClipHistory([initial]);
    const edited = makeClip({
      revision: 2,
      sourceStart: 0.123456789,
      sourceEnd: 0.987654321,
      fadeIn: { duration: 0.23456789, shape: 'exponential' },
    });
    h.commit([edited], 'edit');
    assert.equal(h.current[0].sourceStart, 0.123456789);
    const u1 = h.undo()!;
    assert.equal(u1.clips[0].sourceStart, 0);
    assert.equal(u1.clips[0].revision, 1);
    h.redo();
    for (let i = 0; i < 5; i++) {
      h.undo();
      h.redo();
    }
    assert.equal(h.current[0].sourceStart, 0.123456789);
    assert.equal(h.current[0].sourceEnd, 0.987654321);
    assert.equal(h.current[0].fadeIn.duration, 0.23456789);
    assert.equal(h.current[0].fadeIn.shape, 'exponential');
    assert.equal(h.current[0].revision, 2);
  });
});

describe('AudioEngine 片段播放（模拟环境）', () => {
  let eng: InstanceType<typeof AudioEngine>;
  const track = baseTrack({ id: 't1', duration: 1 });

  beforeEach(async () => {
    eng = new AudioEngine();
    await eng.resume();
    await eng.ensureTrack(track);
  });
  afterEach(() => eng.dispose());

  const voicesMap = () =>
    (eng as unknown as {
      clipVoices: Map<
        string,
        {
          source: FakeBufferSource;
          clipFade: FakeGain;
          playing: boolean;
          successor: unknown;
        }
      >;
    }).clipVoices;

  it('播放片段：源偏移从入点开始、寿命限定为出点长度，并带淡化包络', async () => {
    const clip = makeClip({
      sourceStart: 0.2,
      sourceEnd: 0.8,
      fadeIn: { duration: 0.1, shape: 'linear' },
      fadeOut: { duration: 0.1, shape: 'linear' },
    });
    await eng.playClip(clip, track);
    const v = voicesMap().get('c1')!;
    const last = v.source.started[v.source.started.length - 1];
    assert.ok(Math.abs(last.offset - 0.2) < 1e-9);
    assert.ok(Math.abs((last.duration ?? 0) - 0.6) < 1e-9);
    // 起点增益为 0（淡入起点），且存在一条淡入曲线
    assert.ok(Math.abs(v.clipFade.gain.value) < 1e-9);
    assert.ok(v.clipFade.gain.curves.length >= 1);
  });

  it('两条片段经 playClips 在同一 ctx 时刻启动（共用同一时钟），各自方位取声轨 panner', async () => {
    const clipA = makeClip({ id: 'a', trackId: 't1', sourceStart: 0, sourceEnd: 0.5 });
    const otherTrack = baseTrack({ id: 't2', position: { x: -3, y: 0, z: 0 } });
    await eng.ensureTrack(otherTrack);
    const clipB = makeClip({ id: 'b', trackId: 't2', sourceStart: 0.1, sourceEnd: 0.6 });
    const ctx = eng.ctx as unknown as FakeAudioContext;
    const results = await eng.playClips([
      { clip: clipA, track },
      { clip: clipB, track: otherTrack },
    ]);
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => !r.error));
    const vm = voicesMap();
    const ta = vm.get('a')!.source.started.at(-1)!.time;
    const tb = vm.get('b')!.source.started.at(-1)!.time;
    assert.equal(ta, tb); // 同一调度时刻
    assert.ok(ta > ctx.currentTime || ta === ctx.currentTime + 0.03 || Math.abs(ta - (ctx.currentTime + 0.03)) < 1e-6);
    // panner 方位跟随各自声轨
    const pa = (vm.get('a') as unknown as { panner: FakePanner }).panner;
    const pb = (vm.get('b') as unknown as { panner: FakePanner }).panner;
    assert.ok(Math.abs(pa.positionX.value - 2) < 1e-9);
    assert.ok(Math.abs(pb.positionX.value - -3) < 1e-9);
  });

  it('越界、源缺失、解码失败产生独立错误而非静音', async () => {
    const badRange = makeClip({ id: 'oob', sourceEnd: 5, sourceDuration: 1 });
    const res = await eng.playClips([{ clip: badRange, track }]);
    assert.equal(res[0].error?.reason, 'out-of-range');

    const missing = makeClip({ id: 'miss', trackId: 'ghost' });
    await assert.rejects(
      eng.playClip(missing, undefined),
      (e: unknown) => e instanceof ClipPlayError && (e as ClipPlayError).reason === 'missing-source',
    );

    const bad = baseTrack({ id: 'badfile', sourceType: 'file' as const });
    eng.setFileBlob('badfile', new Blob([new TextEncoder().encode('BAD')], { type: 'audio/x' }));
    const clipDec = makeClip({ id: 'dec', trackId: 'badfile' });
    await assert.rejects(
      eng.playClip(clipDec, bad),
      (e: unknown) => e instanceof ClipPlayError && (e as ClipPlayError).reason === 'source-decode-error',
    );
  });

  it('播放中提交编辑：返回 deferred 且不立即换源；越过安全边界后单一后继发声，无双重播放', async () => {
    const clip = makeClip({
      sourceStart: 0,
      sourceEnd: 0.3,
      loop: { enabled: true, start: 0, count: Number.POSITIVE_INFINITY },
    });
    await eng.playClip(clip, track);
    const vm = voicesMap();
    const v1 = vm.get('c1')!;
    const startedCountBefore = v1.source.started.length;

    const edited = makeClip({
      revision: 2,
      sourceStart: 0,
      sourceEnd: 0.2,
      loop: { enabled: true, start: 0, count: Number.POSITIVE_INFINITY },
    });
    const r = eng.stageClipEdit(edited, track);
    assert.equal(r.deferred, true);
    // 当前声未换源
    assert.equal(v1.source.started.length, startedCountBefore);
    // 已武装后继
    const armed = (v1 as unknown as { successor: { source: FakeBufferSource } | null }).successor;
    assert.ok(armed != null);

    // 推进时间越过边界（边界 ctx 时刻 = start + 0.3）
    const succStart = armed.source.started.at(-1)!.time;
    (eng.ctx as unknown as FakeAudioContext).currentTime = succStart + 0.01;
    await new Promise((res) => setTimeout(res, 60)); // 等 25ms 边界定时器
    const head = voicesMap().get('c1')!;
    // 提升后只有一个声：后继；旧声已被物理停止
    assert.equal(head, armed);
    assert.ok(v1.source.stopped.length >= 1);
    assert.equal(head.playing, true);
  });

  it('播放中提交非法编辑被拒绝，当前声不受影响', async () => {
    const clip = makeClip({ sourceStart: 0, sourceEnd: 0.4 });
    await eng.playClip(clip, track);
    const v1 = voicesMap().get('c1')!;
    const illegal = makeClip({ revision: 2, sourceEnd: 9 });
    assert.throws(() => eng.stageClipEdit(illegal, track), ClipValidationError);
    assert.equal((v1 as unknown as { successor: unknown }).successor, null);
  });

  it('未播放时提交编辑立即换描述，下次播放采用新边界；暂停/停止不残留双重声', async () => {
    const clip = makeClip({ sourceStart: 0, sourceEnd: 0.5 });
    await eng.playClip(clip, track);
    eng.pauseClip('c1');
    const edited = makeClip({ revision: 2, sourceStart: 0.1, sourceEnd: 0.4 });
    const r = eng.stageClipEdit(edited, track);
    assert.equal(r.deferred, false);
    await eng.playClip(edited, track);
    const v = voicesMap().get('c1')!;
    assert.ok(Math.abs(v.source.started.at(-1)!.offset - 0.1) < 1e-9);
    eng.stopClip('c1');
    assert.equal(eng.isClipPlaying('c1'), false);
    assert.equal(voicesMap().get('c1')!.source.started.length, 0);
  });

  it('循环前导(loopStart>入点)：每段精确引用源区间，回绕不播入点前素材', async () => {
    const ctx = eng.ctx as unknown as FakeAudioContext;
    const clip = makeClip({
      sourceStart: 0.2,
      sourceEnd: 0.8,
      loop: { enabled: true, start: 0.5, count: Number.POSITIVE_INFINITY },
    });
    await eng.playClip(clip, track);
    const vm = voicesMap();
    let head = vm.get('c1')!;
    // 首段：源偏移 0.2，段长到回跳点 0.3
    assert.ok(Math.abs(head.source.started[0].offset - 0.2) < 1e-9);
    assert.ok(Math.abs((head.source.started[0].duration ?? 0) - 0.3) < 1e-9);
    let armed = (head as unknown as { successor: { source: FakeBufferSource } }).successor;
    // 第二段（循环体）：源偏移 0.5，段长 0.3
    assert.ok(Math.abs(armed.source.started[0].offset - 0.5) < 1e-9);
    assert.ok(Math.abs((armed.source.started[0].duration ?? 0) - 0.3) < 1e-9);
    // 越过第一次边界
    ctx.currentTime = armed.source.started[0].time + 0.01;
    await new Promise((res) => setTimeout(res, 60));
    head = vm.get('c1')!;
    assert.ok(Math.abs(head.source.started[0].offset - 0.5) < 1e-9);
    // 提升后自动武装再下一段，仍是 0.5 起（绝不回到入点 0.2 之前）
    armed = (head as unknown as { successor: { source: FakeBufferSource } }).successor;
    assert.ok(Math.abs(armed.source.started[0].offset - 0.5) < 1e-9);
  });

  it('有限循环在规定次数后：末段为 terminal、不再武装后继；onended 后归零', async () => {
    const ctx = eng.ctx as unknown as FakeAudioContext;
    const clip = makeClip({
      sourceStart: 0,
      sourceEnd: 0.2,
      loop: { enabled: true, start: 0, count: 2 },
    });
    await eng.playClip(clip, track);
    const vm = voicesMap();
    // 2 轮 = 段 [0,.2) 与 [.2,.4)，只有一次边界提升
    const h = vm.get('c1')! as unknown as {
      source: FakeBufferSource;
      successor: { source: FakeBufferSource } | null;
      terminal: boolean;
    };
    const succ = h.successor;
    assert.ok(succ, '第 1 段应武装后继');
    ctx.currentTime = succ.source.started[0].time + 0.01;
    await new Promise((res) => setTimeout(res, 60));
    const head = vm.get('c1')! as unknown as {
      successor: unknown;
      terminal: boolean;
      timelineEnd: number;
    };
    // 已到第 2 轮（末段）：寿命 0.4，terminal=true 且无后继
    assert.equal(head.terminal, true);
    assert.ok(Math.abs(head.timelineEnd - 0.4) < 1e-9);
    assert.equal(head.successor, null);

    // 模拟真实浏览器：末段持续时长耗尽触发 onended → 播放归零、无残留
    const onended = (head as unknown as { source: { onended: (() => void) | null } }).source.onended;
    assert.ok(onended);
    onended!();
    assert.equal(eng.isClipPlaying('c1'), false);
  });
});
