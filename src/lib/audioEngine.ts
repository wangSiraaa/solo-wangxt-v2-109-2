/**
 * AudioEngine —— Web Audio 核心，与 React 状态解耦。
 *
 * 信号链（每条声轨）：
 *   AudioBufferSourceNode ──► [ChannelSplitter 选取单声道]
 *      ──► trackGain ──► PannerNode(HRTF + 明确距离模型) ──► soloBus ──► busGain
 *                                          └（非独奏/静音）──► muteBus(增益0) ──┘
 *                                                                              ▼
 *                                                        masterGain ─► peakWorklet(逐采样峰值/削波)
 *                                                                              ├► AnalyserNode(回退表)
 *                                                                              └► AudioDestination
 *
 * 关键约定：
 *  - 移动声源只更新 PannerNode 的 position AudioParam（setTargetAtTime 平滑），
 *    绝不 stop/start 源节点，因此移动不会重启音轨。
 *  - 静音 = trackGain.gain=0；独奏通过 soloBus/muteBus 真实切换路由。
 *  - 峰值/削波在实际输出链末端（destination 之前）由 AudioWorklet 逐采样检测；
 *    Worklet 不可用时回退到 AnalyserNode 时域峰值（同样在输出链上）。
 *  - AudioContext 必须由用户手势解锁；解码失败逐条声轨以 DecodeError 上报。
 */
import type {
  Clip,
  LevelState,
  ListenerState,
  SpatialSettings,
  Track,
  UnlockState,
} from '../types';
import { forwardVector } from './spatial';
import { createSampleBuffer } from './samples';
import {
  CLIP_EPS,
  assertValidClip,
  clipLength,
  fadeGain,
} from './clip';

interface TrackVoice {
  trackId: string;
  spec: Track;
  source: AudioBufferSourceNode;
  trackGain: GainNode;
  /** 片段淡化节点汇入点；整轨播放时为恒定 1 的直通增益 */
  clipGain: GainNode;
  panner: PannerNode;
  /** true = 接在 soloBus（可听见）；false = 接在增益为 0 的 muteBus */
  audiblyRouted: boolean;
  playing: boolean;
  consumed: boolean; // source 是否已 start 过（结束后必须重建才能再播）
  startedAt: number;
  offset: number;
  duration: number;
}

/** 片段播放中的一个调度段（一整段首遍或一遍循环）；每段独立源与淡化节点 */
interface ScheduledSlice {
  source: AudioBufferSourceNode;
  sliceGain: GainNode;
  startAt: number; // ctx 绝对时间
  endAt: number;
  localStart: number; // 片段本地时间轴位置
  localEnd: number;
}

interface ClipStream {
  clip: Clip;
  slices: ScheduledSlice[];
  /** 已排到该本地位置（= 最后一段 localEnd；无段时为起始 localPos） */
  cursor: number;
  finished: boolean;
}

interface ClipPlay {
  clipId: string;
  /** 当前可闻流（换流后为新流；其首段可能起播于未来的安全边界） */
  stream: ClipStream | null;
  /** 换流时保留到安全边界自然结束的旧段（边界后自行断开并被回收） */
  outgoing: ScheduledSlice[];
  /** 暂停后的恢复位置；stream 为 null 且非换流等待态时有意义 */
  resumeLocal: number;
  /** 安全边界上要切换到的新片段描述（播放中编辑，只在边界生效） */
  armed: Clip | null;
  /** armed 换流的边界时刻（当前可闻旧段的结束时间） */
  boundary: number | null;
  endedNotified: boolean;
}

export class ClipError extends Error {
  trackId: string;
  clipId?: string;
  constructor(trackId: string, message: string, clipId?: string) {
    super(message);
    this.name = 'ClipError';
    this.trackId = trackId;
    this.clipId = clipId;
  }
}

export type EngineUnlockListener = (state: UnlockState) => void;
export type EngineLevelListener = (level: LevelState) => void;
export type EngineEndedListener = (trackId: string) => void;

export class DecodeError extends Error {
  trackId: string;
  constructor(trackId: string, message: string) {
    super(message);
    this.name = 'DecodeError';
    this.trackId = trackId;
  }
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  unlock: UnlockState = 'locked';

  private busGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private soloBus: GainNode | null = null;
  private muteBus: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private timeDomainBuf: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(8192));
  private peakWorklet: AudioWorkletNode | null = null;
  private workletFailed = false;

  private voices = new Map<string, TrackVoice>();
  private buffers = new Map<string, AudioBuffer>();
  private pendingFiles = new Map<string, Blob>();
  /** 每轨最多一个片段播放；逐段都在同一个 AudioContext 时钟上调度 */
  private clipPlays = new Map<string, ClipPlay>();

  private spatial: SpatialSettings | null = null;
  private anySolo = false;

  private unlockListeners = new Set<EngineUnlockListener>();
  private levelListeners = new Set<EngineLevelListener>();
  private endedListeners = new Set<EngineEndedListener>();
  private rafHandle = 0;
  private clipLatchL = false;
  private clipLatchR = false;
  private lastPeak: LevelState = { l: 0, r: 0, clipL: false, clipR: false };

  onUnlock(fn: EngineUnlockListener): () => void {
    this.unlockListeners.add(fn);
    fn(this.unlock);
    return () => {
      this.unlockListeners.delete(fn);
    };
  }
  onLevels(fn: EngineLevelListener): () => void {
    this.levelListeners.add(fn);
    return () => {
      this.levelListeners.delete(fn);
    };
  }
  onEnded(fn: EngineEndedListener): () => void {
    this.endedListeners.add(fn);
    return () => {
      this.endedListeners.delete(fn);
    };
  }

  private emitUnlock() {
    this.unlockListeners.forEach((fn) => fn(this.unlock));
  }

  /** 必须在用户手势中调用；与“未解锁”分别上报明确的失败状态 */
  async resume(): Promise<void> {
    if (this.unlock === 'unlocked' && this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    this.unlock = 'unlocking';
    this.emitUnlock();
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error('当前浏览器不支持 Web Audio API');
      const ctx = new Ctor();
      this.ctx = ctx;
      this.buildGraph(ctx);
      if (ctx.state === 'suspended') await ctx.resume();
      if (ctx.state !== 'running') {
        throw new Error('AudioContext 被浏览器策略阻止，未能进入 running 状态');
      }
      this.unlock = 'unlocked';
      this.emitUnlock();
      this.startMeterLoop();
      void this.ensurePeakWorklet(ctx);
    } catch (err) {
      this.unlock = 'failed';
      this.emitUnlock();
      throw err;
    }
  }

  private buildGraph(ctx: AudioContext) {
    this.soloBus = ctx.createGain();
    this.muteBus = ctx.createGain();
    this.muteBus.gain.value = 0;
    this.busGain = ctx.createGain();
    this.masterGain = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.timeDomainBuf = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));

    this.soloBus.connect(this.busGain);
    this.muteBus.connect(this.busGain);
    this.busGain.connect(this.masterGain);
    // 先经过 analyser（回退表）；worklet 加载成功后串入 master 与 destination 之间
    this.masterGain.connect(this.analyser);
    this.analyser.connect(ctx.destination);
  }

  /**
   * 峰值/削波检测器串联在 masterGain 之后、destination 之前的真实输出链上，
   * 逐采样扫描。Worklet 源码以 Blob 注入，无需额外网络资源。
   */
  private async ensurePeakWorklet(ctx: AudioContext): Promise<boolean> {
    if (this.peakWorklet || this.workletFailed) return !!this.peakWorklet;
    try {
      const workletSource = `
class PeakMeterProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const in0 = inputs[0];
    const out0 = outputs[0];
    if (!in0 || in0.length === 0) {
      // 上游静默优化时输出保持零填充即可
      return true;
    }
    let peakL = 0, peakR = 0, clipL = false, clipR = false;
    const l = in0[0];
    const r = in0[1] || in0[0];
    const ol = out0[0];
    const or = out0[1] || out0[0];
    for (let i = 0; i < l.length; i++) {
      const vl = l[i];
      const al = Math.abs(vl);
      if (al > peakL) peakL = al;
      if (al >= 1.0) clipL = true;
      if (ol) ol[i] = vl; // 必须显式透传，否则输出静音
    }
    if (r && or) for (let i = 0; i < r.length; i++) {
      const vr = r[i];
      const ar = Math.abs(vr);
      if (ar > peakR) peakR = ar;
      if (ar >= 1.0) clipR = true;
      if (out0[1]) or[i] = vr;
    }
    this.port.postMessage({ l: peakL, r: peakR, clipL, clipR });
    return true;
  }
}
registerProcessor('peak-meter', PeakMeterProcessor);
`;
      const blob = new Blob([workletSource], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }

      const node = new AudioWorkletNode(ctx, 'peak-meter', {
        // 节点串在真实输出链上：必须保持立体声直通，避免被下混成单声道
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.channelCount = 2;
      node.channelInterpretation = 'speakers';
      // 重排实际链路：masterGain -> peakWorklet -> analyser -> destination
      this.masterGain!.disconnect();
      this.masterGain!.connect(node);
      this.analyser!.disconnect();
      node.connect(this.analyser!);
      this.analyser!.connect(ctx.destination);
      node.port.onmessage = (e: MessageEvent<LevelState>) => {
        const d = e.data;
        if (d.clipL) this.clipLatchL = true;
        if (d.clipR) this.clipLatchR = true;
        this.lastPeak = { l: d.l, r: d.r, clipL: this.clipLatchL, clipR: this.clipLatchR };
      };
      this.peakWorklet = node;
      return true;
    } catch {
      this.workletFailed = true;
      return false;
    }
  }

  clearClipLatch() {
    this.clipLatchL = false;
    this.clipLatchR = false;
  }

  private startMeterLoop() {
    const tick = () => {
      if (!this.peakWorklet && this.analyser) {
        // 回退：AnalyserNode 时域块峰值，仍挂在真实输出链上
        this.analyser.getFloatTimeDomainData(this.timeDomainBuf);
        let peak = 0;
        for (let i = 0; i < this.timeDomainBuf.length; i++) {
          const a = Math.abs(this.timeDomainBuf[i]);
          if (a > peak) peak = a;
        }
        if (peak >= 1) {
          this.clipLatchL = true;
          this.clipLatchR = true;
        }
        this.lastPeak = {
          l: peak,
          r: peak,
          clipL: this.clipLatchL,
          clipR: this.clipLatchR,
        };
      }
      const p = this.lastPeak;
      this.levelListeners.forEach((fn) => fn({ ...p }));
      this.pumpScheduler();
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  /**
   * 片段逐段调度（与电平表共用同一个 rAF/音频时钟节拍）。
   * 用闭式时间排程而不是每段 start 后再排下一段：多轨共用同一 AudioContext
   * 绝对时钟，循环不累积抖动，两条同步样例在指定区间内保持同一时钟。
   */
  pumpScheduler(): void {
    if (!this.ctx || this.unlock !== 'unlocked') return;
    const now = this.ctx.currentTime;
    const LEAD = 0.3;
    for (const [trackId, play] of this.clipPlays) {
      // 回收换流后保留的旧段：它们在边界自然停止，到点断开（从不强停发声源）
      play.outgoing = play.outgoing.filter((s) => {
        if (s.endAt > now - 0.05) return true;
        this.teardownSlice(s);
        return false;
      });

      const stream = play.stream;
      if (stream) {
        stream.slices = stream.slices.filter((s) => {
          if (s.endAt > now - 0.05) return true;
          this.teardownSlice(s);
          return false;
        });
        if (!stream.finished) {
          // armed 换流挂起时，旧流只补排到安全边界为止，绝不越过边界（避免双播）
          this.scheduleAhead(trackId, stream, play.armed ? play.boundary : null);
        }
        if (stream.finished && stream.slices.length === 0 && play.outgoing.length === 0) {
          const voice = this.voices.get(trackId);
          if (voice) voice.playing = false;
          this.finishClipPlay(trackId, play);
          continue;
        }
      }

      // armed 换流：边界进入预排窗口时，提前建好新流节点，
      // 但新源 start(boundary) 由音频线程在边界采样级精确起播；
      // 旧段只在 outgoing 中留到同一时刻自然结束 → 无间隙、无双重播放。
      if (play.armed && play.boundary != null && play.stream && play.boundary <= now + LEAD) {
        const boundary = play.boundary;
        const oldStream = play.stream;
        // 保留恰好在边界结束的当前可闻段；拆掉所有边界之后的预排段（尚未发声）
        const kept = oldStream.slices.filter((s) => s.endAt <= boundary + CLIP_EPS);
        const dropped = oldStream.slices.filter((s) => s.endAt > boundary + CLIP_EPS);
        for (const s of dropped) this.teardownSlice(s);
        play.outgoing.push(...kept);
        const next = play.armed;
        play.armed = null;
        play.boundary = null;
        // startStream 会把 play.stream 指向新流（首段 startAt = boundary）
        this.startStream(trackId, next, 0, boundary);
      }
    }
  }

  private teardownSlice(s: ScheduledSlice): void {
    try {
      s.source.onended = null;
      s.source.stop();
    } catch {
      /* 已自然结束 */
    }
    s.source.disconnect();
    s.sliceGain.disconnect();
  }

  private finishClipPlay(trackId: string, play: ClipPlay): void {
    play.stream = null;
    play.outgoing = [];
    if (!play.endedNotified) {
      play.endedNotified = true;
      this.endedListeners.forEach((fn) => fn(trackId));
    }
    this.clipPlays.delete(trackId);
  }

  // ---------- 全局参数 ----------

  setSpatialSettings(s: SpatialSettings) {
    this.spatial = s;
    if (!this.ctx) return;
    for (const v of this.voices.values()) {
      v.panner.distanceModel = s.distanceModel;
      v.panner.refDistance = s.refDistance;
      v.panner.rolloffFactor = s.rolloffFactor;
      v.panner.maxDistance = s.maxDistance;
    }
  }

  setBusGain(g: number) {
    if (this.busGain && this.ctx) {
      this.busGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01);
    }
  }

  setMasterGain(g: number) {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01);
    }
  }

  /** 听者位置/朝向；朝向定义与 spatial.ts、Three.js 相机严格一致 */
  setListener(l: ListenerState) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = forwardVector(l.yaw, l.pitch);
    const u = localUp(l.yaw, l.pitch);
    const li = this.ctx.listener;
    const set = (p: AudioParam | undefined, v: number) => {
      if (p) p.setTargetAtTime(v, t, 0.02);
    };
    set(li.positionX, l.position.x);
    set(li.positionY, l.position.y);
    set(li.positionZ, l.position.z);
    set(li.forwardX, f.x);
    set(li.forwardY, f.y);
    set(li.forwardZ, f.z);
    set(li.upX, u.x);
    set(li.upY, u.y);
    set(li.upZ, u.z);
  }

  // ---------- 声轨缓冲与节点 ----------

  /**
   * 确保声轨缓冲与节点就绪。
   * 已存在的 voice 只做实时参数更新（位置/增益/路由/loop），绝不重启源。
   */
  async ensureTrack(track: Track): Promise<void> {
    if (!this.ctx || this.unlock !== 'unlocked') return;

    let buffer = this.buffers.get(track.id);
    if (!buffer) {
      if (track.sourceType === 'file') {
        const blob = this.pendingFiles.get(track.id);
        if (!blob) return; // Blob 尚未由 UI 从 IndexedDB 注入
        try {
          const arr = await blob.arrayBuffer();
          // slice(0)：decodeAudioData 会 detach ArrayBuffer，保留原始 Blob 不受影响
          buffer = await this.ctx.decodeAudioData(arr.slice(0));
        } catch (err) {
          throw new DecodeError(
            track.id,
            `音频解码失败：${err instanceof Error ? err.message : '不支持的编码或文件损坏'}`,
          );
        }
      } else {
        buffer = createSampleBuffer(this.ctx, track.sourceType);
      }
      this.buffers.set(track.id, buffer);
    }

    const existing = this.voices.get(track.id);
    if (!existing) {
      this.voices.set(track.id, this.createVoice(track, buffer));
    } else {
      this.updateVoiceLive(existing, track);
    }
  }

  /** 文件 Blob 在解锁后由 UI 层提供（来自 IndexedDB，全程本地） */
  setFileBlob(trackId: string, blob: Blob) {
    this.pendingFiles.set(trackId, blob);
  }

  dropBuffer(trackId: string) {
    this.buffers.delete(trackId);
  }

  private createVoice(track: Track, buffer: AudioBuffer): TrackVoice {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = track.loop;

    const trackGain = ctx.createGain();
    trackGain.gain.value = track.muted ? 0 : track.gain;
    // 片段淡化/逐段增益汇入点；整轨播放时恒定 1（真实在链上，而非旁路）
    const clipGain = ctx.createGain();
    clipGain.gain.value = 1;

    const panner = new PannerNode(ctx, {
      panningModel: 'HRTF',
      distanceModel: this.spatial?.distanceModel ?? 'inverse',
      refDistance: this.spatial?.refDistance ?? 1,
      rolloffFactor: this.spatial?.rolloffFactor ?? 1,
      maxDistance: this.spatial?.maxDistance ?? 100,
      positionX: track.position.x,
      positionY: track.position.y,
      positionZ: track.position.z,
    });

    // 立体声文件：HRTF 需要单声道输入，显式选取文件原始左/右声道
    if (buffer.numberOfChannels <= 1) {
      source.connect(trackGain);
    } else {
      const splitter = ctx.createChannelSplitter(buffer.numberOfChannels);
      source.connect(splitter);
      const ch = Math.min(track.channel, buffer.numberOfChannels - 1);
      // splitter 单口输出为单声道，接入立体声 gain 时浏览器自动等声级上混
      splitter.connect(trackGain, ch);
    }
    trackGain.connect(clipGain);
    clipGain.connect(panner);

    const audible = this.shouldBeAudible(track);
    panner.connect(audible ? this.soloBus! : this.muteBus!);

    const voice: TrackVoice = {
      trackId: track.id,
      spec: track,
      source,
      trackGain,
      clipGain,
      panner,
      audiblyRouted: audible,
      playing: false,
      consumed: false,
      startedAt: 0,
      offset: 0,
      duration: buffer.duration,
    };

    source.onended = () => {
      if (!voice.playing) return; // stop() 触发的 onended 忽略
      // 片段播放时 source 由调度器管理，自然结束由 pumpScheduler 回收/续排，
      // 不在此重建整轨 voice，避免与片段流双重播放。
      if (this.clipPlays.has(track.id)) return;
      const latest = voice.spec;
      voice.playing = false;
      voice.consumed = true;
      voice.offset = 0;
      // 以最新参数立即重建待播 voice，保证自然结束后再次按播放不会对已结束 source start
      const fresh = this.createVoice(latest, buffer);
      fresh.offset = 0;
      this.voices.set(track.id, fresh);
      this.endedListeners.forEach((fn) => fn(track.id));
    };
    return voice;
  }

  private shouldBeAudible(track: Track): boolean {
    if (track.muted) return false;
    if (this.anySolo) return track.solo;
    return true;
  }

  /** 实时参数更新：不触碰 source 节点 —— 移动声源不会重启音轨 */
  private updateVoiceLive(voice: TrackVoice, track: Track) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const tau = Math.max(0.005, this.spatial?.positionTimeConstant ?? 0.05);

    voice.panner.positionX.setTargetAtTime(track.position.x, t, tau);
    voice.panner.positionY.setTargetAtTime(track.position.y, t, tau);
    voice.panner.positionZ.setTargetAtTime(track.position.z, t, tau);
    voice.panner.distanceModel = this.spatial?.distanceModel ?? voice.panner.distanceModel;

    voice.trackGain.gain.setTargetAtTime(track.muted ? 0 : track.gain, t, 0.01);
    if (voice.source.loop !== track.loop) voice.source.loop = track.loop;

    const audible = this.shouldBeAudible(track);
    if (audible !== voice.audiblyRouted) {
      voice.panner.disconnect();
      voice.panner.connect(audible ? this.soloBus! : this.muteBus!);
      voice.audiblyRouted = audible;
    }
    voice.spec = track;
  }

  /** 静音/独奏变化：重新评估全部路由（增益本身在 updateVoiceLive 中已设置） */
  reevaluateRouting(tracks: Track[]) {
    this.anySolo = tracks.some((t) => t.solo);
    if (!this.ctx) return;
    for (const tr of tracks) {
      const v = this.voices.get(tr.id);
      if (!v) continue;
      const audible = this.shouldBeAudible(tr);
      if (audible !== v.audiblyRouted) {
        v.panner.disconnect();
        v.panner.connect(audible ? this.soloBus! : this.muteBus!);
        v.audiblyRouted = audible;
      }
      v.trackGain.gain.setTargetAtTime(tr.muted ? 0 : tr.gain, this.ctx.currentTime, 0.01);
      v.spec = tr;
    }
  }

  /**
   * 高频实时同步：对已存在的 voice 更新位置/增益/loop/独奏路由。
   * 不创建节点、不触碰 source，移动声源不会重启音轨。
   * 尚未创建 voice 的声轨（未解锁/未解码）跳过，由 ensureTrack 负责。
   */
  syncTracks(tracks: Track[]) {
    if (!this.ctx) return;
    this.anySolo = tracks.some((t) => t.solo);
    for (const tr of tracks) {
      const v = this.voices.get(tr.id);
      if (v) this.updateVoiceLive(v, tr);
    }
  }

  getChannelCount(trackId: string): number | null {
    return this.buffers.get(trackId)?.numberOfChannels ?? null;
  }

  /**
   * 重建声轨输入图（切换立体声文件的 L/R 声道时使用）。
   * 保持播放偏移；若原本在播放，从同一位置继续（声道选择本身不属于“移动”）。
   */
  async rebuildVoiceGraph(track: Track): Promise<void> {
    await this.ensureTrack(track);
    const old = this.voices.get(track.id);
    const buf = this.buffers.get(track.id);
    if (!old || !buf) return;
    const wasPlaying = old.playing;
    const offset = wasPlaying ? this.currentOffset(old) : old.offset;
    const nv = this.replaceVoice(old, track, buf, offset);
    if (wasPlaying) {
      nv.source.start(this.ctx!.currentTime, offset);
      nv.startedAt = this.ctx!.currentTime;
      nv.playing = true;
      nv.consumed = true;
    }
  }

  // ---------- 传输控制 ----------

  async playTrack(track: Track): Promise<void> {
    const activeClip = track.activeClipId
      ? track.clips.find((c) => c.id === track.activeClipId)
      : undefined;
    if (activeClip) {
      // 暂停态（无流但有播放记录）从原位置继续
      const paused = this.clipPlays.get(track.id);
      if (paused && !paused.stream) {
        await this.resumeClip(track);
        return;
      }
      await this.playClip(track, activeClip);
      return;
    }
    await this.ensureTrack(track);
    let voice = this.voices.get(track.id);
    if (!voice) return;
    if (voice.playing) return;
    if (voice.consumed) {
      // 自然结束后未被 onended 重建的兜底
      const buf = this.buffers.get(track.id)!;
      voice = this.replaceVoice(voice, track, buf, voice.offset);
    }
    const ctx = this.ctx!;
    voice.source.start(ctx.currentTime, voice.offset % voice.duration);
    voice.startedAt = ctx.currentTime;
    voice.playing = true;
    voice.consumed = true;
  }

  pauseTrack(track: Track) {
    if (this.pauseClip(track)) return;
    const voice = this.voices.get(track.id);
    if (!voice || !voice.playing) return;
    voice.offset = this.currentOffset(voice);
    this.replaceVoice(voice, track, this.buffers.get(track.id)!, voice.offset);
  }

  stopTrack(track: Track) {
    if (this.stopClip(track)) return;
    const voice = this.voices.get(track.id);
    if (!voice) return;
    if (voice.playing || voice.consumed) {
      this.replaceVoice(voice, track, this.buffers.get(track.id)!, 0);
    } else {
      voice.offset = 0;
    }
  }

  /** 跳转：offsetSec 秒处；autoplay=true 时立即继续播放。片段播放时在片段本地时间轴上跳转 */
  async seekTrack(track: Track, offsetSec: number, autoplay: boolean) {
    // 正在播放/挂起的片段优先；否则用活动片段；都没有则整轨
    const targetId = this.clipPlays.get(track.id)?.clipId ?? track.activeClipId;
    const clip = targetId ? track.clips.find((c) => c.id === targetId) : undefined;
    if (clip) {
      await this.seekClip(track, clip.id, offsetSec, autoplay);
      return;
    }
    await this.ensureTrack(track);
    const voice = this.voices.get(track.id);
    const buf = this.buffers.get(track.id);
    if (!voice || !buf) return;
    const offset = track.loop
      ? ((offsetSec % buf.duration) + buf.duration) % buf.duration
      : Math.min(Math.max(0, offsetSec), buf.duration);
    const nv = this.replaceVoice(voice, track, buf, offset);
    if (autoplay) {
      nv.source.start(this.ctx!.currentTime, offset);
      nv.startedAt = this.ctx!.currentTime;
      nv.playing = true;
      nv.consumed = true;
    }
  }

  /**
   * 停止旧节点并按最新参数重建（仅用于暂停/停止/跳转）。
   * 位置移动严禁走此路径。
   */
  private replaceVoice(
    old: TrackVoice,
    track: Track,
    buffer: AudioBuffer,
    offset: number,
  ): TrackVoice {
    try {
      old.source.onended = null;
      old.source.stop();
    } catch {
      /* 已停止 */
    }
    old.source.disconnect();
    old.trackGain.disconnect();
    old.clipGain.disconnect();
    old.panner.disconnect();
    const nv = this.createVoice(track, buffer);
    nv.offset = offset;
    this.voices.set(track.id, nv);
    return nv;
  }

  private currentOffset(v: TrackVoice): number {
    let p = v.offset + (this.ctx!.currentTime - v.startedAt);
    p = v.spec.loop ? ((p % v.duration) + v.duration) % v.duration : Math.min(p, v.duration);
    return p;
  }

  removeTrack(trackId: string) {
    const play = this.clipPlays.get(trackId);
    if (play) {
      if (play.stream) for (const s of play.stream.slices) this.teardownSlice(s);
      for (const s of play.outgoing) this.teardownSlice(s);
      this.clipPlays.delete(trackId);
    }
    const voice = this.voices.get(trackId);
    if (voice) {
      try {
        voice.source.onended = null;
        voice.source.stop();
      } catch {
        /* ignore */
      }
      voice.source.disconnect();
      voice.trackGain.disconnect();
      voice.clipGain.disconnect();
      voice.panner.disconnect();
    }
    this.voices.delete(trackId);
    this.buffers.delete(trackId);
    this.pendingFiles.delete(trackId);
  }

  getProgress(trackId: string): number | null {
    const clip = this.getClipProgress(trackId);
    if (clip) return clip.current;
    const v = this.voices.get(trackId);
    if (!v) return null;
    return v.playing ? this.currentOffset(v) : v.offset;
  }

  getDuration(trackId: string): number | null {
    return this.buffers.get(trackId)?.duration ?? null;
  }

  isPlaying(trackId: string): boolean {
    if (this.clipPlays.has(trackId)) return true;
    return this.voices.get(trackId)?.playing ?? false;
  }

  /** 当前播放/暂停挂起的片段 id；整轨播放时为 null */
  playingClipId(trackId: string): string | null {
    return this.clipPlays.get(trackId)?.clipId ?? null;
  }

  // ---------- 非破坏性片段播放（只引用原始缓冲区间，绝不复制采样） ----------

  /**
   * 播放指定片段。播放前做三道硬校验，任何一道失败都抛出明确错误，
   * 不启动任何节点——绝不以静音“假成功”掩盖：
   *   1) 缓冲可用（未解码 / Blob 缺失 / 解码失败分别报因）
   *   2) 原文件时长与片段记录一致（时长变化报因）
   *   3) 片段边界/淡化/循环在当前缓冲上合法（越界/重叠报因）
   */
  async playClip(track: Track, clip: Clip): Promise<void> {
    await this.ensureTrack(track);
    const buf = this.buffers.get(track.id);
    if (!buf) {
      throw new ClipError(
        track.id,
        track.status === 'decode-error'
          ? `原始文件解码失败，片段不可试听：${track.errorMessage ?? ''}`
          : '原始音频尚未就绪，片段暂不可试听',
        clip.id,
      );
    }
    if (
      clip.sourceDuration != null &&
      Math.abs(buf.duration - clip.sourceDuration) > CLIP_EPS
    ) {
      throw new ClipError(
        track.id,
        `原文件时长已变化（记录 ${clip.sourceDuration.toFixed(3)}s，实际 ${buf.duration.toFixed(3)}s），片段边界需要重新审阅`,
        clip.id,
      );
    }
    assertValidClip(clip, buf.duration);

    const play = this.clipPlays.get(track.id);
    if (play) {
      // 已在播放（同一/另一片段）：通过安全边界换流，不重启 voice
      this.armClip(track.id, clip);
      return;
    }
    this.clipPlays.set(track.id, {
      clipId: clip.id,
      stream: null,
      outgoing: [],
      resumeLocal: 0,
      armed: null,
      boundary: null,
      endedNotified: false,
    });
    this.startStream(track.id, clip, 0, this.ctx!.currentTime);
  }

  /**
   * 播放中提交的新边界/淡化：只在明确的安全边界（当前可闻段结束）生效。
   * 边界之后的预排段立即拆除（尚未发声）；当前可闻段保留到边界自然结束；
   * 新流节点提前创建、源 start(boundary) 由音频线程在边界精确起播，
   * 不 stop 任何正在发声的源，也不重启无关轨，杜绝双重播放。
   * 暂停态（无流）不属于播放中：直接把新描述记为恢复目标。
   */
  armClip(trackId: string, next: Clip): void {
    const play = this.clipPlays.get(trackId);
    if (!play) return;
    const buf = this.buffers.get(trackId);
    if (!buf) throw new ClipError(trackId, '原始音频尚未就绪，无法应用片段修改', next.id);
    assertValidClip(next, buf.duration);
    if (!play.stream) {
      play.clipId = next.id;
      play.armed = null;
      play.boundary = null;
      play.resumeLocal = Math.min(play.resumeLocal, clipLength(next) - CLIP_EPS);
      return;
    }
    const now = this.ctx!.currentTime;
    // 已挂起的换流（新源尚未到边界起播）先取消：拆新流未发声段，恢复旧段
    if (play.armed && play.boundary != null && play.boundary > now + CLIP_EPS) {
      const pending = play.stream;
      for (const s of pending.slices) this.teardownSlice(s);
      pending.slices = play.outgoing.splice(0);
      pending.cursor = pending.slices.reduce((m, s) => Math.max(m, s.localEnd), 0);
      pending.finished = false;
      play.armed = null;
      play.boundary = null;
    }
    if (play.armed) {
      // 边界已到/已过：旧换流已交给 pump 执行，忽略这次重复 arm（不丢正在发声段）
      return;
    }
    // 安全边界 = 当前正在发声的段的结束点（绝不把边界放在段中间）
    const audible = play.stream.slices.find((s) => now >= s.startAt && now < s.endAt);
    const boundary = audible ? audible.endAt : play.stream.slices[0]?.endAt ?? now;
    // 拆掉边界之后的旧预排段（未发声）
    const keep = play.stream.slices.filter((s) => s.endAt <= boundary + CLIP_EPS);
    const drop = play.stream.slices.filter((s) => s.endAt > boundary + CLIP_EPS);
    for (const s of drop) this.teardownSlice(s);
    play.armed = next;
    play.clipId = next.id;
    play.boundary = boundary;
    // 边界已在预排窗口（或恰为当前）内：立即把旧段移入 outgoing 并建边界起播的新流；
    // 否则只挂起——旧流仍保持未 finished 继续续排，pump 在边界前 0.3s 才真正换流
    if (boundary <= now + 0.3) {
      play.stream.slices = keep;
      play.stream.finished = true;
      play.outgoing.push(...keep);
      play.armed = null;
      play.boundary = null;
      this.startStream(trackId, next, 0, Math.max(now, boundary));
    } else {
      // 已拆段写回（只留边界内的段），再补齐旧流预排到边界为止，保证无缝不越界
      play.stream.slices = keep;
      play.stream.cursor = keep.reduce((m, s) => Math.max(m, s.localEnd), 0);
      this.scheduleAhead(trackId, play.stream, boundary);
    }
    this.pumpScheduler();
  }

  /** 停止该轨的片段播放（清空调度，不等边界） */
  private clearClipPlay(trackId: string): number {
    const play = this.clipPlays.get(trackId);
    if (!play) return 0;
    const local = play.stream ? this.clipCurrentLocal(play) : play.resumeLocal;
    if (play.stream) for (const s of play.stream.slices) this.teardownSlice(s);
    for (const s of play.outgoing) this.teardownSlice(s);
    this.clipPlays.delete(trackId);
    return local;
  }

  /**
   * 启动一条片段流：从本地位置 startLocal 开始，第一个源在 startAt 起播。
   * startAt 可以是当前时刻（新播放）或未来的边界时刻（安全换流）。
   */
  private startStream(trackId: string, clip: Clip, startLocal: number, startAt: number): void {
    const voice = this.voices.get(trackId);
    if (!voice) return;
    // 片段流接管期间静音整轨的“常驻源”（它处于 consumed 未 start 或 idle 态，
    // 从不发声）；每段 sliceGain 负责淡化，恒定汇入 voice.clipGain。
    const stream: ClipStream = { clip, slices: [], cursor: startLocal, finished: false };
    const play = this.clipPlays.get(trackId);
    if (play) play.stream = stream;
    voice.clipGain.gain.value = 1;
    voice.playing = true;
    this.scheduleSlice(trackId, clip, stream, startLocal, startAt);
    this.scheduleAhead(trackId, stream, null);
  }

  /**
   * 预排流上的后续段（约 0.3s 提前量）。
   * 用绝对结束时间推进，而不是本地游标：循环时本地位置每圈回到循环入点，
   * 但段的 ctx 绝对时间单调前进——两轨所有段共用同一 AudioContext 时钟。
   * @param stopAt 非 null 时只补排到该安全边界为止（armed 换流的旧流），绝不越界
   */
  private scheduleAhead(trackId: string, stream: ClipStream, stopAt: number | null): void {
    const horizon = this.ctx!.currentTime + 0.3;
    const limit = stopAt ?? Infinity;
    let guard = 0;
    const looping = stream.clip.loop.enabled;
    while (!stream.finished && guard < 4096) {
      const lastEnd = this.streamLastEnd(stream);
      if (lastEnd >= Math.min(horizon, limit)) {
        if (!looping || stopAt != null) break;
        // 覆盖时间窗口后，循环流再补齐到至少 3 圈：边界全部以闭式绝对时间预排
        const loopCount = stream.slices.length - 1;
        if (loopCount >= 3) break;
      }
      const nextStartAt = this.nextSliceStartTime(stream);
      if (nextStartAt >= limit) break;
      this.scheduleSlice(trackId, stream.clip, stream, stream.cursor, nextStartAt);
      guard++;
    }
  }

  private streamLastEnd(stream: ClipStream): number {
    const s = stream.slices[stream.slices.length - 1];
    return s ? s.endAt : -Infinity;
  }

  /** 下一段的起始绝对时间 = 最后一段结束时间；无段时为当前时刻 */
  private nextSliceStartTime(stream: ClipStream): number {
    const last = stream.slices[stream.slices.length - 1];
    return last ? last.endAt : this.ctx!.currentTime;
  }

  /**
   * 排程一个播放段。
   * 首遍区域 = 完整片段 [inPoint, outPoint)；循环区域 = [loopIn, loopOut)。
   * 每段从“区域内位置”regionPos 播到区域结尾；淡化锚定在区域位置上，
   * 因此每次循环都有同样的淡入淡出，首遍与循环体各自完整。
   */
  private scheduleSlice(
    trackId: string,
    clip: Clip,
    stream: ClipStream,
    localStart: number,
    startAt: number,
  ): void {
    const ctx = this.ctx!;
    const voice = this.voices.get(trackId)!;
    const buffer = this.buffers.get(trackId)!;

    const len = clipLength(clip);
    const firstPass = localStart < len - CLIP_EPS * 2;
    let regionStart: number;
    let regionEnd: number;
    let regionPos: number;
    if (firstPass) {
      regionStart = clip.inPoint;
      regionEnd = clip.outPoint;
      regionPos = Math.min(Math.max(0, localStart), len - CLIP_EPS);
    } else {
      regionStart = clip.loop.inPoint;
      regionEnd = clip.loop.outPoint;
      const regionLen0 = Math.max(CLIP_EPS, clip.loop.outPoint - clip.loop.inPoint);
      regionPos = ((localStart - len) % regionLen0 + regionLen0) % regionLen0;
    }
    const regionLen = regionEnd - regionStart;
    const sourceOffset = regionStart + regionPos;
    const duration = Math.max(CLIP_EPS, regionEnd - sourceOffset);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = false; // 循环由调度器按同一时钟逐段排程，避免源级循环吞掉边界
    const sliceGain = ctx.createGain();
    if (buffer.numberOfChannels <= 1) {
      source.connect(sliceGain);
    } else {
      const splitter = ctx.createChannelSplitter(buffer.numberOfChannels);
      source.connect(splitter);
      const ch = Math.min(voice.spec.channel, buffer.numberOfChannels - 1);
      splitter.connect(sliceGain, ch);
    }
    sliceGain.connect(voice.clipGain);

    const endAt = startAt + duration;
    source.start(Math.max(0, startAt), sourceOffset, duration);
    source.stop(endAt + 0.02);
    // 自然结束后自行断开（换流后脱离调度循环的段也能被回收，不依赖 rAF）
    source.onended = () => {
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      try {
        sliceGain.disconnect();
      } catch {
        /* already disconnected */
      }
    };

    // 淡化自动化落在本段独立增益上；各段互不串扰
    this.applySliceEnvelope(sliceGain, clip, startAt, regionPos, regionLen);

    const consumedLocal = regionLen - regionPos;
    const localEnd = localStart + consumedLocal;
    const slice: ScheduledSlice = {
      source,
      sliceGain,
      startAt,
      endAt,
      localStart,
      localEnd,
    };
    stream.slices.push(slice);
    stream.cursor = localEnd;

    if (!clip.loop.enabled) stream.finished = true;
  }

  /**
   * 写入一段的淡入/淡出自动化（锚定区域位置）。
   * 用密集等功率/线性曲线，保证从区域内部起播（seek/恢复）时起点包络连续。
   */
  private applySliceEnvelope(
    gain: GainNode,
    clip: Clip,
    startAt: number,
    regionPos: number,
    regionLen: number,
  ): void {
    const param = gain.gain;
    param.cancelScheduledValues(startAt);

    const N = 96;
    const envAt = (p: number): number => {
      let g = 1;
      if (clip.fadeIn.length > 0 && p < clip.fadeIn.length) {
        g = Math.min(g, fadeGain(clip.fadeIn.curve, p / clip.fadeIn.length));
      }
      const tail = regionLen - p;
      if (clip.fadeOut.length > 0 && tail < clip.fadeOut.length) {
        g = Math.min(g, fadeGain(clip.fadeOut.curve, 1 - tail / clip.fadeOut.length));
      }
      return Math.max(0.0001, g);
    };

    // 从当前区域位置到区域结束，逐 ~10ms 采样整条包络
    const span = Math.max(CLIP_EPS, regionLen - regionPos);
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const p = regionPos + (span * i) / (N - 1);
      curve[i] = envAt(Math.min(p, regionLen - CLIP_EPS));
    }
    param.setValueCurveAtTime(curve, startAt, span);
  }

  /** 当前播放到的片段本地位置（秒） */
  private clipCurrentLocal(play: ClipPlay): number {
    const stream = play.stream;
    const now = this.ctx!.currentTime;
    if (!stream || stream.slices.length === 0) return play.resumeLocal;
    let active = stream.slices.find((s) => now >= s.startAt && now < s.endAt);
    if (!active) {
      const first = stream.slices[0];
      active = now < first.startAt ? first : stream.slices[stream.slices.length - 1];
    }
    const into = Math.max(0, now - active.startAt);
    return Math.min(active.localEnd, active.localStart + into);
  }

  /** 片段播放进度：返回本地位置与本地总时长；非片段播放返回 null */
  getClipProgress(trackId: string): { current: number; duration: number; clipId: string } | null {
    const play = this.clipPlays.get(trackId);
    if (!play) return null;
    const clip =
      play.stream?.clip ?? play.armed ?? this.findClipById(trackId, play.clipId);
    if (!clip) return null;
    const local = play.stream
      ? this.clipCurrentLocal(play)
      : play.outgoing.length
        ? this.outgoingLocal(play)
        : play.resumeLocal;
    return { current: local, duration: clipLength(clip), clipId: play.clipId };
  }

  private findClipById(trackId: string, clipId: string): Clip | null {
    const t = this.voices.get(trackId)?.spec;
    return t?.clips.find((c) => c.id === clipId) ?? null;
  }

  private outgoingLocal(play: ClipPlay): number {
    const now = this.ctx!.currentTime;
    const s = [...play.outgoing].sort((a, b) => b.endAt - a.endAt)[0];
    const into = Math.max(0, now - s.startAt);
    return Math.min(s.localEnd, s.localStart + into);
  }

  pauseClip(track: Track): boolean {
    const play = this.clipPlays.get(track.id);
    if (!play) return false;
    const local = play.stream
      ? this.clipCurrentLocal(play)
      : play.outgoing.length
        ? this.outgoingLocal(play)
        : play.resumeLocal;
    if (play.stream) for (const s of play.stream.slices) this.teardownSlice(s);
    for (const s of play.outgoing) this.teardownSlice(s);
    play.stream = null;
    play.outgoing = [];
    play.armed = null;
    play.boundary = null;
    play.resumeLocal = local;
    const v = this.voices.get(track.id);
    if (v) v.playing = false;
    return true;
  }

  /** 恢复暂停的片段（从暂停的本地位置继续） */
  async resumeClip(track: Track): Promise<void> {
    const play = this.clipPlays.get(track.id);
    if (!play || play.stream) return;
    const clip = this.findClip(track, play.clipId);
    if (!clip) {
      this.clipPlays.delete(track.id);
      throw new ClipError(track.id, '片段描述已不存在');
    }
    const buf = this.buffers.get(track.id);
    if (!buf) throw new ClipError(track.id, '原始音频尚未就绪');
    assertValidClip(clip, buf.duration);
    const startLocal = this.clampLocal(clip, play.resumeLocal);
    play.endedNotified = false;
    this.startStream(track.id, clip, startLocal, this.ctx!.currentTime);
  }

  stopClip(track: Track): boolean {
    if (!this.clipPlays.has(track.id)) return false;
    this.clearClipPlay(track.id);
    const v = this.voices.get(track.id);
    if (v) v.playing = false;
    return true;
  }

  /** 片段内跳转；autoplay 语义与整轨 seek 一致 */
  async seekClip(track: Track, clipId: string, localSec: number, autoplay: boolean): Promise<void> {
    const clip = this.findClip(track, clipId);
    if (!clip) throw new ClipError(track.id, '片段不存在', clipId);
    const buf = this.buffers.get(track.id);
    if (!buf) throw new ClipError(track.id, '原始音频尚未就绪', clipId);
    assertValidClip(clip, buf.duration);
    const wasPlaying = this.clipPlays.has(track.id);
    if (wasPlaying) this.clearClipPlay(track.id);
    const local = this.clampLocal(clip, localSec);
    if (!autoplay) {
      this.clipPlays.set(track.id, {
        clipId: clip.id,
        stream: null,
        outgoing: [],
        resumeLocal: local,
        armed: null,
        boundary: null,
        endedNotified: true, // 暂停态不触发结束通知
      });
      return;
    }
    this.clipPlays.set(track.id, {
      clipId: clip.id,
      stream: null,
      outgoing: [],
      resumeLocal: local,
      armed: null,
      boundary: null,
      endedNotified: false,
    });
    this.startStream(track.id, clip, local, this.ctx!.currentTime);
  }

  private clampLocal(clip: Clip, local: number): number {
    const len = clipLength(clip);
    const l = Math.min(Math.max(0, local), len - CLIP_EPS);
    return l;
  }

  private findClip(track: Track, clipId: string): Clip | undefined {
    return track.clips.find((c) => c.id === clipId);
  }

  dispose() {
    cancelAnimationFrame(this.rafHandle);
    for (const id of [...this.voices.keys()]) this.removeTrack(id);
    void this.ctx?.close();
    this.ctx = null;
    this.unlock = 'locked';
  }
}

/**
 * 听者本地 +Y(上) 经 yaw(绕世界Y，正值右转) 与 pitch(绕本地右向量，正值抬头)
 * 后的世界上方向量。满足 right = forward × up。
 */
function localUp(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // 抬头时头顶略向 +Z（听者身后）倾；再绕世界 Y 按“右转”约定施加 yaw
  return {
    x: -sp * Math.sin(yaw),
    y: cp,
    z: sp * Math.cos(yaw),
  };
}
