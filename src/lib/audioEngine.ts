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
  ClipIssue,
  LevelState,
  ListenerState,
  SpatialSettings,
  Track,
  UnlockState,
} from '../types';
import { forwardVector } from './spatial';
import { createSampleBuffer } from './samples';
import {
  clipFadeGain,
  clipTimelineLifespan,
  fadeShapeGain,
  sourceDurationChanged,
  validateClipFields,
  ClipValidationError,
} from './clipEdit';

interface TrackVoice {
  trackId: string;
  spec: Track;
  source: AudioBufferSourceNode;
  trackGain: GainNode;
  panner: PannerNode;
  /** true = 接在 soloBus（可听见）；false = 接在增益为 0 的 muteBus */
  audiblyRouted: boolean;
  playing: boolean;
  consumed: boolean; // source 是否已 start 过（结束后必须重建才能再播）
  startedAt: number;
  offset: number;
  duration: number;
}

/**
 * 片段播放声：与声轨共享同一份解码 buffer（buffers 按 trackId 缓存）。
 * 链：source →(splitter 选原始声道)→ clipFade(淡化包络)→ trackGain(静音/增益)
 *     → PannerNode(HRTF) → soloBus/muteBus。
 * 边界/淡化/循环的变更绝不实时重建正在发声的节点，只在“下一安全边界”整体换源，
 * 换源复用同一个 trackGain/panner，因此声像不断、无双重播放。
 */
interface ClipVoice {
  clipId: string;
  spec: Clip;
  channel: number;
  source: AudioBufferSourceNode;
  clipFade: GainNode;
  trackGain: GainNode;
  panner: PannerNode;
  audiblyRouted: boolean;
  playing: boolean;
  startedAt: number; // ctx 时间（可能是未来的精确调度时刻）
  timelineOffset: number; // start 时刻对应的片段时间线位置（秒）
  /** 本段结束的时间线位置（循环回绕边界或片段寿命） */
  timelineEnd: number;
  /** 本段是否为最后一段（其后结束，不再回绕） */
  terminal: boolean;
  /** 播放中提交的编辑：延迟到下一循环/结束边界生效；null = 无待生效编辑 */
  pending: Clip | null;
  /** 已为边界换源预先构建好的后继声（与当前声共用 trackGain/panner） */
  successor: ClipVoice | null;
  retiring: boolean; // 旧声已被调度停止，onended 须忽略
}

/** 片段无法播放/延迟生效时的明确原因（绝不静默假成功） */
export class ClipPlayError extends Error {
  clipId: string;
  reason: ClipIssue;
  constructor(clipId: string, reason: ClipIssue, message: string) {
    super(message);
    this.name = 'ClipPlayError';
    this.clipId = clipId;
    this.reason = reason;
  }
}

export type EngineUnlockListener = (state: UnlockState) => void;
export type EngineLevelListener = (level: LevelState) => void;
export type EngineEndedListener = (trackId: string) => void;
export type EngineClipEndedListener = (clipId: string) => void;
/** 延迟提交的片段编辑在安全边界完成换源 */
export type EngineClipEditAppliedListener = (clipId: string, boundaryTime: number) => void;

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
  private clipVoices = new Map<string, ClipVoice>();
  private buffers = new Map<string, AudioBuffer>();
  private pendingFiles = new Map<string, Blob>();
  /** 已知缺失/不可读的本地 Blob：播放片段时据此给出独立原因 */
  private missingBlobs = new Set<string>();

  private spatial: SpatialSettings | null = null;
  private anySolo = false;

  private unlockListeners = new Set<EngineUnlockListener>();
  private levelListeners = new Set<EngineLevelListener>();
  private endedListeners = new Set<EngineEndedListener>();
  private clipEndedListeners = new Set<EngineClipEndedListener>();
  private clipEditAppliedListeners = new Set<EngineClipEditAppliedListener>();
  private boundaryTimer: ReturnType<typeof setInterval> | null = null;
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
  onClipEnded(fn: EngineClipEndedListener): () => void {
    this.clipEndedListeners.add(fn);
    return () => {
      this.clipEndedListeners.delete(fn);
    };
  }
  onClipEditApplied(fn: EngineClipEditAppliedListener): () => void {
    this.clipEditAppliedListeners.add(fn);
    return () => {
      this.clipEditAppliedListeners.delete(fn);
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
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
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
    for (const cv of this.clipVoices.values()) {
      cv.panner.distanceModel = s.distanceModel;
      cv.panner.refDistance = s.refDistance;
      cv.panner.rolloffFactor = s.rolloffFactor;
      cv.panner.maxDistance = s.maxDistance;
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

    // 声轨节点层：Blob 尚未注入时保持 pending（UI 另行按轨标记缺失/解码失败），
    // 不在这里抛错；片段播放走 ensureTrackBuffer，会拿到明确原因。
    let buffer: AudioBuffer;
    try {
      buffer = await this.ensureTrackBuffer(track);
    } catch (err) {
      if (err instanceof ClipPlayError && err.reason === 'source-missing-blob') return;
      throw err;
    }

    const existing = this.voices.get(track.id);
    if (!existing) {
      this.voices.set(track.id, this.createVoice(track, buffer));
    } else {
      this.updateVoiceLive(existing, track);
    }
  }

  /**
   * 解析（必要时解码/合成）声轨对应的原始 AudioBuffer。
   * 片段与声轨共享同一份缓存：片段只读引用，不复制音频数据。
   * 解码失败抛 DecodeError；Blob 缺失抛 ClipPlayError('source-missing-blob')。
   */
  async ensureTrackBuffer(track: Track): Promise<AudioBuffer> {
    const cached = this.buffers.get(track.id);
    if (cached) return cached;
    if (!this.ctx) throw new Error('音频尚未解锁');
    let buffer: AudioBuffer;
    if (track.sourceType === 'file') {
      const blob = this.pendingFiles.get(track.id);
      if (!blob) {
        if (this.missingBlobs.has(track.id)) {
          throw new ClipPlayError(
            '__track__',
            'source-missing-blob',
            '本地音频 Blob 缺失',
          );
        }
        // Blob 尚未由 UI 注入：不生成静音，明确报错而不是假成功
        throw new ClipPlayError('__track__', 'source-missing-blob', '本地音频尚未就绪');
      }
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
    return buffer;
  }

  /** 文件 Blob 在解锁后由 UI 层提供（来自 IndexedDB，全程本地） */
  setFileBlob(trackId: string, blob: Blob) {
    this.missingBlobs.delete(trackId);
    this.pendingFiles.set(trackId, blob);
  }

  /** 显式标记本地 Blob 缺失（IndexedDB 查无此键），片段播放时给独立原因 */
  markBlobMissing(trackId: string) {
    this.pendingFiles.delete(trackId);
    this.missingBlobs.add(trackId);
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
    trackGain.connect(panner);

    const audible = this.shouldBeAudible(track);
    panner.connect(audible ? this.soloBus! : this.muteBus!);

    const voice: TrackVoice = {
      trackId: track.id,
      spec: track,
      source,
      trackGain,
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
      if (v) {
        const audible = this.shouldBeAudible(tr);
        if (audible !== v.audiblyRouted) {
          v.panner.disconnect();
          v.panner.connect(audible ? this.soloBus! : this.muteBus!);
          v.audiblyRouted = audible;
        }
        v.trackGain.gain.setTargetAtTime(tr.muted ? 0 : tr.gain, this.ctx.currentTime, 0.01);
        v.spec = tr;
      }
      for (const cv of this.clipVoices.values()) {
        if (cv.spec.trackId !== tr.id || cv.retiring) continue;
        this.updateClipLive(cv, tr);
      }
    }
  }

  /**
   * 高频实时同步：对已存在的 voice 更新位置/增益/loop/独奏路由。
   * 不创建节点、不触碰 source，移动声源不会重启音轨。
   * 尚未创建 voice 的声轨（未解锁/未解码）跳过，由 ensureTrack 负责。
   * 正在播放的片段同样只实时更新 panner/gain/路由，其边界/淡化/循环保持不变。
   */
  syncTracks(tracks: Track[]) {
    if (!this.ctx) return;
    this.anySolo = tracks.some((t) => t.solo);
    for (const tr of tracks) {
      const v = this.voices.get(tr.id);
      if (v) this.updateVoiceLive(v, tr);
      for (const cv of this.clipVoices.values()) {
        if (cv.spec.trackId !== tr.id || cv.retiring) continue;
        this.updateClipLive(cv, tr);
      }
    }
  }

  /** 片段声的实时参数：只动 AudioParam/路由，绝不换源重启 */
  private updateClipLive(cv: ClipVoice, track: Track) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const tau = Math.max(0.005, this.spatial?.positionTimeConstant ?? 0.05);
    cv.panner.positionX.setTargetAtTime(track.position.x, t, tau);
    cv.panner.positionY.setTargetAtTime(track.position.y, t, tau);
    cv.panner.positionZ.setTargetAtTime(track.position.z, t, tau);
    cv.panner.distanceModel = this.spatial?.distanceModel ?? cv.panner.distanceModel;
    cv.channel = track.channel;
    cv.trackGain.gain.setTargetAtTime(track.muted ? 0 : track.gain, t, 0.01);
    const audible = this.shouldBeAudible(track);
    if (audible !== cv.audiblyRouted) {
      cv.panner.disconnect();
      cv.panner.connect(audible ? this.soloBus! : this.muteBus!);
      cv.audiblyRouted = audible;
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
    const voice = this.voices.get(track.id);
    if (!voice || !voice.playing) return;
    voice.offset = this.currentOffset(voice);
    this.replaceVoice(voice, track, this.buffers.get(track.id)!, voice.offset);
  }

  stopTrack(track: Track) {
    const voice = this.voices.get(track.id);
    if (!voice) return;
    if (voice.playing || voice.consumed) {
      this.replaceVoice(voice, track, this.buffers.get(track.id)!, 0);
    } else {
      voice.offset = 0;
    }
  }

  /** 跳转：offsetSec 秒处；autoplay=true 时立即继续播放 */
  async seekTrack(track: Track, offsetSec: number, autoplay: boolean) {
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

  // ---------- 非破坏性片段播放 ----------

  /**
   * 解析片段引用声轨的源缓冲，并做全部“不能静音假成功”的前置检查：
   * 声轨缺失 / Blob 缺失 / 解码失败 / 时长变化后越界，均抛明确错误。
   */
  private async resolveClip(
    clip: Clip,
    track: Track | undefined,
  ): Promise<{ track: Track; buffer: AudioBuffer }> {
    if (!track) {
      throw new ClipPlayError(clip.id, 'missing-source', `片段引用的声轨已不存在：${clip.trackId}`);
    }
    let buffer: AudioBuffer;
    try {
      buffer = await this.ensureTrackBuffer(track);
    } catch (err) {
      if (err instanceof DecodeError) {
        throw new ClipPlayError(clip.id, 'source-decode-error', err.message);
      }
      if (err instanceof ClipPlayError) {
        throw new ClipPlayError(clip.id, err.reason, err.message);
      }
      throw err;
    }
    if (sourceDurationChanged(clip, buffer.duration) && clip.sourceEnd > buffer.duration + 1e-6) {
      throw new ClipPlayError(
        clip.id,
        'out-of-range',
        `原文件时长已由 ${clip.sourceDuration.toFixed(3)}s 变为 ${buffer.duration.toFixed(3)}s，片段出点越界，拒绝播放`,
      );
    }
    if (clip.sourceStart < -1e-9 || clip.sourceEnd > buffer.duration + 1e-6) {
      throw new ClipPlayError(
        clip.id,
        'out-of-range',
        `片段范围 ${clip.sourceStart.toFixed(3)}–${clip.sourceEnd.toFixed(3)}s 超出源时长 ${buffer.duration.toFixed(3)}s`,
      );
    }
    return { track, buffer };
  }

  private createClipVoice(
    clip: Clip,
    track: Track,
    buffer: AudioBuffer,
    shared?: { trackGain: GainNode; panner: PannerNode },
  ): ClipVoice {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const clipFade = ctx.createGain();
    clipFade.gain.value = 0; // 未 start 前保持静音，由包络在调度时刻拉起

    // 与声轨相同的原始声道选择规则（立体声文件显式选原始 L/R）
    if (buffer.numberOfChannels <= 1) {
      source.connect(clipFade);
    } else {
      const splitter = ctx.createChannelSplitter(buffer.numberOfChannels);
      source.connect(splitter);
      const ch = Math.min(track.channel, buffer.numberOfChannels - 1);
      splitter.connect(clipFade, ch);
    }

    let trackGain: GainNode;
    let panner: PannerNode;
    if (shared) {
      trackGain = shared.trackGain;
      panner = shared.panner;
    } else {
      trackGain = ctx.createGain();
      trackGain.gain.value = track.muted ? 0 : track.gain;
      panner = new PannerNode(ctx, {
        panningModel: 'HRTF',
        distanceModel: this.spatial?.distanceModel ?? 'inverse',
        refDistance: this.spatial?.refDistance ?? 1,
        rolloffFactor: this.spatial?.rolloffFactor ?? 1,
        maxDistance: this.spatial?.maxDistance ?? 100,
        positionX: track.position.x,
        positionY: track.position.y,
        positionZ: track.position.z,
      });
      const audible = this.shouldBeAudible(track);
      panner.connect(audible ? this.soloBus! : this.muteBus!);
    }
    clipFade.connect(trackGain);
    if (!shared) trackGain.connect(panner);

    const cv: ClipVoice = {
      clipId: clip.id,
      spec: clip,
      channel: track.channel,
      source,
      clipFade,
      trackGain,
      panner,
      audiblyRouted: shared ? true : this.shouldBeAudible(track),
      playing: false,
      startedAt: 0,
      timelineOffset: 0,
      timelineEnd: 0,
      terminal: true,
      pending: null,
      successor: null,
      retiring: false,
    };

    source.onended = () => {
      if (cv.retiring) return; // 边界换源/停止触发的 onended 忽略
      if (cv.successor) return; // 已安排后继（循环回绕），由提升流程负责
      cv.playing = false;
      // 末段自然结束：以最新编辑描述重建待播声（时间线归零），绝不留下残余发声
      const stopped = this.createClipVoice(cv.spec, this.latestTrackFor(cv), buffer, undefined);
      this.clipVoices.set(clip.id, stopped);
      this.clipEndedListeners.forEach((fn) => fn(clip.id));
    };
    return cv;
  }

  private latestTrackFor(cv: ClipVoice): Track {
    const v = this.voices.get(cv.spec.trackId);
    return v ? v.spec : ({
      id: cv.spec.trackId,
      gain: 1,
      muted: false,
      solo: false,
      channel: cv.channel,
      position: { x: 0, y: 0, z: 0 },
    } as Track);
  }

  /**
   * 在调度时刻 when（AudioContext 共用时钟）从片段时间线 T0 开始发声一段。
   * 不使用原生 loop：循环回绕 = 在边界处换一段从 loop.start 开始的新 source，
   * 这样当 loop.start > sourceStart 时绝不会错误播到入点之前的素材。
   * 每段都显式 start(when, 源偏移, 段长)，并在有后继边界时只预先武装“下一段”
   * （不递归整链）；下一段提升后再武装它的后继，避免无限循环时无限预建。
   */
  private armClipVoice(cv: ClipVoice, when: number, t0: number) {
    const clip = cv.spec;
    const seg = this.segmentAt(clip, t0);
    if (!seg) {
      throw new ClipPlayError(clip.id, 'out-of-range', '起始位置已超出片段寿命');
    }
    cv.source.start(when, seg.srcOffset, seg.duration);
    cv.startedAt = when;
    cv.timelineOffset = seg.timelineStart;
    cv.timelineEnd = seg.timelineEnd;
    cv.terminal = seg.terminal;
    cv.playing = true;

    this.scheduleSegmentEnvelope(cv, when, seg.timelineStart, seg.timelineEnd, seg.terminal);
    this.ensureBoundaryTimer();
  }

  /** 为当前段预先武装下一段（循环回绕）；仅在确实还会继续时调用一次 */
  private armLoopContinuation(cv: ClipVoice) {
    if (cv.terminal || cv.successor || cv.pending) return;
    if (cv.timelineEnd < clipTimelineLifespan(cv.spec) - 1e-9) {
      // 循环回绕：后继用同一编辑描述、从当前段结束的时间线位置开始；边界不静音（无缝）
      this.armSuccessor(cv, cv.spec, cv.timelineEnd, cv.timelineEnd, /* muteOldAtBoundary */ false);
    }
  }

  /** 计算时间线 t0 所在播放段：源偏移、段长、边界时间线位置与是否末段 */
  private segmentAt(
    clip: Clip,
    t0: number,
  ): {
    srcOffset: number;
    duration: number;
    timelineStart: number;
    timelineEnd: number;
    terminal: boolean;
  } | null {
    const life = clipTimelineLifespan(clip);
    if (t0 < -1e-9 || t0 >= life + 1e-9) return null;
    if (!clip.loop.enabled) {
      return {
        srcOffset: clip.sourceStart + t0,
        duration: life - t0,
        timelineStart: t0,
        timelineEnd: life,
        terminal: true,
      };
    }
    const loopOffset = clip.loop.start - clip.sourceStart;
    const loopLen = clip.sourceEnd - clip.loop.start;
    if (t0 < loopOffset) {
      // 首轮前导：sourceStart+t0 → loop.start
      return {
        srcOffset: clip.sourceStart + t0,
        duration: loopOffset - t0,
        timelineStart: t0,
        timelineEnd: loopOffset,
        terminal: false,
      };
    }
    const iteration = Math.floor((t0 - loopOffset) / loopLen);
    const within = t0 - loopOffset - iteration * loopLen;
    const segStartT = loopOffset + iteration * loopLen;
    const segEndT = segStartT + loopLen;
    const terminal = clip.loop.count !== Number.POSITIVE_INFINITY && iteration + 1 >= clip.loop.count;
    return {
      srcOffset: clip.loop.start + within,
      duration: loopLen - within,
      timelineStart: segStartT + within,
      timelineEnd: terminal ? life : segEndT,
      terminal,
    };
  }

  /**
   * 为当前段武装后继段（循环回绕或编辑生效共用同一机制）：
   * 后继在边界时刻启动于时间线 startT0；编辑生效时旧段在边界采样精确静音，
   * 循环回绕则保持 1（无缝）。定时器越过边界后把后继提升为当前声。
   */
  private armSuccessor(
    cv: ClipVoice,
    nextClip: Clip,
    boundaryT: number,
    startT0: number,
    muteOldAtBoundary: boolean,
  ) {
    const buffer = this.buffers.get(nextClip.trackId);
    if (!buffer) return;
    const track = this.latestTrackFor(cv);
    const boundaryCtx = cv.startedAt + (boundaryT - cv.timelineOffset);
    const successor = this.createClipVoice(nextClip, track, buffer, {
      trackGain: cv.trackGain,
      panner: cv.panner,
    });
    successor.audiblyRouted = cv.audiblyRouted;
    cv.successor = successor;
    this.armClipVoice(successor, boundaryCtx, startT0);
    if (muteOldAtBoundary) {
      cv.clipFade.gain.cancelScheduledValues(boundaryCtx);
      cv.clipFade.gain.setValueAtTime(0, boundaryCtx);
    }
  }

  /**
   * 单段淡化包络（全部基于共用时钟在未来调度，不修改任何源数据）：
   * 淡入只在时间线开头出现一次；淡出只落在末段的尾部。
   */
  private scheduleSegmentEnvelope(
    cv: ClipVoice,
    when: number,
    t0: number,
    t1: number,
    terminal: boolean,
  ) {
    const clip = cv.spec;
    const param = cv.clipFade.gain;
    const life = clipTimelineLifespan(clip);
    const CURVE_N = 96;

    param.value = clipFadeGain(clip, t0);

    // 淡入：时间线 [0, fadeIn]
    const fin = clip.fadeIn.duration;
    if (fin > 0 && t0 < fin) {
      const end = Math.min(fin, t1);
      const dur = end - t0;
      const arr = new Float32Array(CURVE_N);
      for (let i = 0; i < CURVE_N; i++) {
        const t = t0 + (dur * i) / (CURVE_N - 1);
        arr[i] = fadeShapeGain(t / fin, clip.fadeIn.shape);
      }
      param.setValueCurveAtTime(arr, when, Math.max(0.001, dur));
    }

    // 淡出：只在末段尾部，时间线 [life-fadeOut, life]
    const fout = clip.fadeOut.duration;
    if (terminal && fout > 0) {
      const outStart = life - fout;
      if (t1 > outStart) {
        const start = Math.max(outStart, t0);
        const dur = t1 - start;
        const arr = new Float32Array(CURVE_N);
        for (let i = 0; i < CURVE_N; i++) {
          const t = start + (dur * i) / (CURVE_N - 1);
          arr[i] = fadeShapeGain((life - t) / fout, clip.fadeOut.shape);
        }
        param.setValueCurveAtTime(arr, when + (start - t0), Math.max(0.001, dur));
      }
    }
  }

  /** 播放单个片段（时间线起点，或给定位置） */
  async playClip(clip: Clip, track: Track | undefined, timelineT = 0): Promise<void> {
    if (!this.ctx || this.unlock !== 'unlocked') {
      throw new ClipPlayError(clip.id, 'missing-source', '音频尚未解锁');
    }
    const existing = this.clipVoices.get(clip.id);
    if (existing?.playing) return;
    const { track: tr, buffer } = await this.resolveClip(clip, track);
    validateClipFields(
      {
        sourceStart: clip.sourceStart,
        sourceEnd: clip.sourceEnd,
        fadeIn: clip.fadeIn,
        fadeOut: clip.fadeOut,
        loop: clip.loop,
      },
      buffer.duration,
    );
    if (existing) this.teardownClipChain(existing, false);
    const cv = this.createClipVoice(clip, tr, buffer);
    this.clipVoices.set(clip.id, cv);
    this.armClipVoice(cv, this.ctx.currentTime + 0.01, timelineT);
    this.armLoopContinuation(cv);
  }

  /**
   * 多片段/多轨共用同一时钟播放：先解析全部源（各自独立报错），
   * 再取同一个未来时刻一次性 start 全部源，保证逐采样对齐。
   * 返回每条片段的独立失败原因（失败的不会发声，绝不以静音冒充成功）。
   */
  async playClips(
    items: { clip: Clip; track: Track | undefined }[],
  ): Promise<{ clipId: string; error?: ClipPlayError }[]> {
    const results: { clipId: string; error?: ClipPlayError }[] = [];
    if (!this.ctx || this.unlock !== 'unlocked') {
      return items.map(({ clip }) => ({
        clipId: clip.id,
        error: new ClipPlayError(clip.id, 'missing-source', '音频尚未解锁'),
      }));
    }
    const ready: { clip: Clip; track: Track; buffer: AudioBuffer }[] = [];
    for (const { clip, track } of items) {
      try {
        if (this.clipVoices.get(clip.id)?.playing) continue;
        const r = await this.resolveClip(clip, track);
        validateClipFields(
          {
            sourceStart: clip.sourceStart,
            sourceEnd: clip.sourceEnd,
            fadeIn: clip.fadeIn,
            fadeOut: clip.fadeOut,
            loop: clip.loop,
          },
          r.buffer.duration,
        );
        ready.push({ clip, track: r.track, buffer: r.buffer });
      } catch (err) {
        const e =
          err instanceof ClipPlayError
            ? err
            : err instanceof ClipValidationError
              ? new ClipPlayError(clip.id, 'out-of-range', err.message)
              : new ClipPlayError(clip.id, 'source-decode-error', String(err));
        results.push({ clipId: clip.id, error: e });
      }
    }
    // 单一调度时刻：所有片段挂在同一 AudioContext 时钟
    const when = this.ctx.currentTime + 0.03;
    for (const { clip, track, buffer } of ready) {
      const ex = this.clipVoices.get(clip.id);
      if (ex) this.teardownClipChain(ex, false);
      const cv = this.createClipVoice(clip, track, buffer);
      this.clipVoices.set(clip.id, cv);
      try {
        this.armClipVoice(cv, when, 0);
        this.armLoopContinuation(cv);
        results.push({ clipId: clip.id });
      } catch (err) {
        results.push({
          clipId: clip.id,
          error: new ClipPlayError(clip.id, 'out-of-range', String(err)),
        });
      }
    }
    return results;
  }

  /** 片段当前时间线位置（秒） */
  getClipProgress(clipId: string): number {
    const v = this.clipVoices.get(clipId);
    if (!v) return 0;
    if (!v.playing) return v.timelineOffset;
    const t = v.timelineOffset + (this.ctx!.currentTime - v.startedAt);
    const life = clipTimelineLifespan(v.spec);
    return isFinite(life) ? Math.min(t, life) : t;
  }

  isClipPlaying(clipId: string): boolean {
    return this.clipVoices.get(clipId)?.playing ?? false;
  }

  /** 是否有已提交、等待安全边界生效的编辑 */
  isClipEditPending(clipId: string): boolean {
    let v: ClipVoice | null | undefined = this.clipVoices.get(clipId);
    while (v) {
      if (v.pending) return true;
      v = v.successor;
    }
    return false;
  }

  pauseClip(clipId: string) {
    const v = this.clipVoices.get(clipId);
    if (!v || !v.playing) return;
    const t = this.getClipProgress(clipId);
    const buffer = this.buffers.get(v.spec.trackId);
    this.teardownClipChain(v, true);
    if (buffer) {
      const cv = this.createClipVoice(v.spec, this.latestTrackFor(v), buffer);
      cv.timelineOffset = t;
      this.clipVoices.set(clipId, cv);
    }
  }

  stopClip(clipId: string) {
    const v = this.clipVoices.get(clipId);
    if (!v) return;
    const buffer = this.buffers.get(v.spec.trackId);
    const spec = v.spec;
    const track = this.latestTrackFor(v);
    this.teardownClipChain(v, true);
    if (buffer) {
      this.clipVoices.set(clipId, this.createClipVoice(spec, track, buffer));
    }
  }

  async seekClip(clip: Clip, track: Track | undefined, timelineT: number, autoplay: boolean) {
    const v = this.clipVoices.get(clip.id);
    if (v) this.teardownClipChain(v, true);
    if (!autoplay) {
      // 未播放时的跳转：只需记忆时间线位置，无需解码（保持与声轨 seek 一致的惰性）
      if (v) {
        const buffer = this.buffers.get(clip.trackId);
        if (buffer) {
          const cv = this.createClipVoice(clip, track ?? this.latestTrackFor(v), buffer);
          cv.timelineOffset = timelineT;
          this.clipVoices.set(clip.id, cv);
        }
      }
      return;
    }
    await this.playClip(clip, track, timelineT);
  }

  /**
   * 提交片段编辑（边界/淡化/循环）。
   * - 立即同步校验（基于当前源时长）：非法即抛 ClipValidationError，不改动任何运行声；
   * - 片段未播放：立即换用新描述（下次播放生效）；
   * - 片段播放中：只在“下一明确安全边界”（循环回跳点或出点）整体换源，
   *   不重启无关轨，不产生双重播放；返回 deferred=true。
   */
  stageClipEdit(
    clip: Clip,
    track: Track | undefined,
  ): { deferred: boolean; boundaryTimeline: number } {
    const buffer = this.buffers.get(clip.trackId);
    if (buffer) {
      validateClipFields(
        {
          sourceStart: clip.sourceStart,
          sourceEnd: clip.sourceEnd,
          fadeIn: clip.fadeIn,
          fadeOut: clip.fadeOut,
          loop: clip.loop,
        },
        buffer.duration,
      );
    }
    // 正在播放的“当前段”（head）总是已为下一边界武装后继（循环回绕或末段占位）。
    // 编辑 = 用新描述取代该武装后继；若已越过边界，则以新描述从时间线 0 立即补武装。
    const head = this.clipVoices.get(clip.id);
    if (!head || !head.playing) {
      if (head) {
        const t = head.timelineOffset;
        this.teardownClipChain(head, true);
        if (buffer && track) {
          const cv = this.createClipVoice(clip, track, buffer);
          cv.timelineOffset = t;
          this.clipVoices.set(clip.id, cv);
        }
      }
      return { deferred: false, boundaryTimeline: 0 };
    }
    if (!buffer || !track) {
      throw new ClipPlayError(clip.id, 'missing-source', '源尚未就绪，无法在播放中应用编辑');
    }

    const boundaryT = head.timelineEnd;
    const ctx = this.ctx;
    if (!ctx) throw new ClipPlayError(clip.id, 'missing-source', '音频尚未解锁');
    // 取消 head 已武装的循环/结束后继，换成编辑后继（边界时刻旧段采样精确静音）
    this.cancelArmedSuccessor(head);
    head.pending = clip;
    if (ctx.currentTime + 0.001 < head.startedAt + (boundaryT - head.timelineOffset)) {
      // 编辑从新片段时间线 0 开始
      this.armSuccessor(head, clip, boundaryT, 0, /* muteOldAtBoundary */ true);
    } else {
      // 极少见：边界刚好已到而定时器尚未提升——直接以新描述从 0 武装（同一边界时刻）
      const boundaryCtx = head.startedAt + (boundaryT - head.timelineOffset);
      const successor = this.createClipVoice(clip, track, buffer, {
        trackGain: head.trackGain,
        panner: head.panner,
      });
      head.successor = successor;
      successor.audiblyRouted = head.audiblyRouted;
      this.armClipVoice(successor, Math.max(boundaryCtx, ctx.currentTime), 0);
    }
    return { deferred: true, boundaryTimeline: boundaryT };
  }

  /** 取消已武装但尚未启动的后继（编辑改主意或撤销时），前驱增益回到当前应得值 */
  private cancelArmedSuccessor(host: ClipVoice) {
    const armed = host.successor;
    if (!armed) return;
    this.disposeVoice(armed, { keepSharedChain: true });
    host.successor = null;
    host.pending = null;
    const now = this.ctx!.currentTime;
    host.clipFade.gain.cancelScheduledValues(now);
    host.clipFade.gain.setValueAtTime(clipFadeGain(host.spec, host.timelineOffset + (now - host.startedAt)), now);
  }

  /** 定时器：在边界过后把后继段提升为当前声（循环回绕或编辑生效同一路径） */
  private ensureBoundaryTimer() {
    if (this.boundaryTimer != null || !this.ctx) return;
    this.boundaryTimer = setInterval(() => {
      this.processBoundaries();
    }, 25);
  }

  private processBoundaries() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const [clipId, head] of [...this.clipVoices]) {
      if (!head.successor) continue;
      // 边界时刻（后继段的 startedAt）已到
      if (now + 0.001 < head.successor.startedAt) continue;
      const old = head;
      const promoted = head.successor;
      const wasEdit = old.pending != null;
      old.successor = null;
      old.pending = null;
      // 旧段在边界处已结束（编辑时还被增益静音），立即物理停止；其 onended 被忽略
      old.retiring = true;
      this.disposeVoice(old, { keepSharedChain: true });
      promoted.pending = null;
      this.clipVoices.set(clipId, promoted);
      if (wasEdit) {
        this.clipEditAppliedListeners.forEach((fn) => fn(clipId, promoted.startedAt));
      }
      // 提升后的当前段负责继续预武装下一段（编辑后继也按新描述继续循环）
      this.armLoopContinuation(promoted);
    }
  }

  private disposeVoice(v: ClipVoice, opts?: { keepSharedChain: boolean }) {
    try {
      v.source.onended = null;
      v.source.stop();
    } catch {
      /* 未启动/已停止：取消其未来调度 */
    }
    try {
      v.source.disconnect();
    } catch {
      /* noop */
    }
    try {
      v.clipFade.disconnect();
    } catch {
      /* noop */
    }
    if (!opts?.keepSharedChain) {
      try {
        v.trackGain.disconnect();
      } catch {
        /* noop */
      }
      try {
        v.panner.disconnect();
      } catch {
        /* noop */
      }
    }
    if (v.successor) this.disposeVoice(v.successor, opts);
  }

  /** 拆除片段整条（可能含已武装后继）播放链 */
  private teardownClipChain(head: ClipVoice, disconnectShared: boolean) {
    try {
      head.source.onended = null;
      head.source.stop();
    } catch {
      /* 取消未来 start/stop */
    }
    this.disposeVoice(head, { keepSharedChain: !disconnectShared });
  }

  removeClip(clipId: string) {
    const v = this.clipVoices.get(clipId);
    if (v) {
      this.teardownClipChain(v, true);
      this.clipVoices.delete(clipId);
    }
  }

  removeTrack(trackId: string) {
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
      voice.panner.disconnect();
    }
    this.voices.delete(trackId);
    // 该轨上的片段播放声一并停止（片段编辑描述由状态层保留，引擎只丢弃运行声）
    for (const [clipId, cv] of [...this.clipVoices]) {
      if (cv.spec.trackId === trackId) {
        this.teardownClipChain(cv, true);
        this.clipVoices.delete(clipId);
      }
    }
    this.buffers.delete(trackId);
    this.pendingFiles.delete(trackId);
    this.missingBlobs.delete(trackId);
  }

  getProgress(trackId: string): number | null {
    const v = this.voices.get(trackId);
    if (!v) return null;
    return v.playing ? this.currentOffset(v) : v.offset;
  }

  getDuration(trackId: string): number | null {
    return this.buffers.get(trackId)?.duration ?? null;
  }

  isPlaying(trackId: string): boolean {
    return this.voices.get(trackId)?.playing ?? false;
  }

  dispose() {
    cancelAnimationFrame(this.rafHandle);
    if (this.boundaryTimer != null) {
      clearInterval(this.boundaryTimer);
      this.boundaryTimer = null;
    }
    for (const id of [...this.clipVoices.keys()]) this.removeClip(id);
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
