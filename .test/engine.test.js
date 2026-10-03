var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/lib/spatial.ts
function forwardVector(yaw, pitch = 0) {
  return {
    x: Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * Math.cos(pitch)
  };
}
var init_spatial = __esm({
  "src/lib/spatial.ts"() {
    "use strict";
  }
});

// src/lib/samples.ts
var samples_exports = {};
__export(samples_exports, {
  SAMPLE_LABELS: () => SAMPLE_LABELS,
  createDuoBuffer: () => createDuoBuffer,
  createPulseBuffer: () => createPulseBuffer,
  createSampleBuffer: () => createSampleBuffer,
  createToneBuffer: () => createToneBuffer
});
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function createPulseBuffer(ctx) {
  const sr = ctx.sampleRate;
  const dur = 1.6;
  const buf = ctx.createBuffer(1, Math.floor(sr * dur), sr);
  const data = buf.getChannelData(0);
  const pulseStarts = [0.05, 0.55, 1.05];
  for (const start of pulseStarts) {
    const s0 = Math.floor(start * sr);
    const n = Math.floor(0.05 * sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.pow(1 - i / n, 1.6);
      data[s0 + i] = Math.sin(2 * Math.PI * 1200 * t) * env * 0.9;
    }
  }
  return buf;
}
function createToneBuffer(ctx) {
  const sr = ctx.sampleRate;
  const dur = 3;
  const buf = ctx.createBuffer(1, Math.floor(sr * dur), sr);
  const data = buf.getChannelData(0);
  const n = data.length;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const fade = Math.min(1, t / 0.02, (dur - t) / 0.05);
    data[i] = Math.sin(2 * Math.PI * 440 * t) * 0.5 * fade;
  }
  return buf;
}
function createDuoBuffer(ctx, _variant) {
  const sr = ctx.sampleRate;
  const dur = 4;
  const buf = ctx.createBuffer(1, Math.floor(sr * dur), sr);
  const data = buf.getChannelData(0);
  const rand = mulberry32(20260929);
  for (let i = 0; i < data.length; i++) {
    const t = i / sr;
    const noise = (rand() * 2 - 1) * 0.18;
    const tone = Math.sin(2 * Math.PI * 330 * t) * 0.28;
    const lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * t);
    const fade = Math.min(1, t / 0.05, (dur - t) / 0.1);
    data[i] = (noise + tone) * (0.6 + 0.4 * lfo) * fade;
  }
  return buf;
}
function createSampleBuffer(ctx, type) {
  switch (type) {
    case "pulse":
      return createPulseBuffer(ctx);
    case "tone":
      return createToneBuffer(ctx);
    case "duoA":
      return createDuoBuffer(ctx, "A");
    case "duoB":
      return createDuoBuffer(ctx, "B");
    default:
      throw new Error(`\u975E\u5185\u7F6E\u6837\u4F8B\u7C7B\u578B: ${type}`);
  }
}
var SAMPLE_LABELS;
var init_samples = __esm({
  "src/lib/samples.ts"() {
    "use strict";
    SAMPLE_LABELS = {
      pulse: "\u8109\u51B2\u6837\u4F8B\uFF08\u65B9\u4F4D\u6D4B\u8BD5\uFF09",
      tone: "\u5355\u97F3\u6837\u4F8B\uFF08\u58F0\u50CF/\u8DDD\u79BB\uFF09",
      duoA: "\u53CC\u58F0\u6E90 A\uFF08\u540C\u6B65\u5DE6\uFF09",
      duoB: "\u53CC\u58F0\u6E90 B\uFF08\u540C\u6B65\u53F3\uFF09"
    };
  }
});

// src/lib/clip.ts
function validateClipDraft(draft, duration) {
  const issues = [];
  const { inPoint, outPoint, fadeIn, fadeOut, loop } = draft;
  if (!isNum(inPoint) || !isNum(outPoint)) {
    issues.push("\u5165\u70B9/\u51FA\u70B9\u5FC5\u987B\u662F\u6709\u9650\u6570\u503C");
    return issues;
  }
  if (inPoint < -CLIP_EPS) issues.push(`\u5165\u70B9 ${fmt(inPoint)}s \u8D8A\u754C\uFF08\u4E0D\u80FD\u5C0F\u4E8E 0\uFF09`);
  if (duration != null && outPoint > duration + CLIP_EPS) {
    issues.push(`\u51FA\u70B9 ${fmt(outPoint)}s \u8D8A\u8FC7\u539F\u6587\u4EF6\u65F6\u957F ${fmt(duration)}s`);
  }
  if (outPoint <= inPoint + CLIP_EPS) issues.push("\u51FA\u70B9\u5FC5\u987B\u4E25\u683C\u665A\u4E8E\u5165\u70B9");
  const clipLen = outPoint - inPoint;
  const checkFade = (f, label) => {
    if (!isNum(f.length)) {
      issues.push(`${label}\u957F\u5EA6\u5FC5\u987B\u662F\u6709\u9650\u6570\u503C`);
      return;
    }
    if (f.length < -CLIP_EPS) issues.push(`${label}\u957F\u5EA6 ${fmt(f.length)}s \u4E0D\u80FD\u4E3A\u8D1F\uFF08\u8D8A\u754C\uFF09`);
    if (f.curve !== "linear" && f.curve !== "equalPower") {
      issues.push(`${label}\u66F2\u7EBF\u7C7B\u578B\u975E\u6CD5`);
    }
  };
  checkFade(fadeIn, "\u6DE1\u5165");
  checkFade(fadeOut, "\u6DE1\u51FA");
  const fi = Math.max(0, fadeIn.length);
  const fo = Math.max(0, fadeOut.length);
  if (fi + fo > clipLen + CLIP_EPS) {
    issues.push(
      `\u6DE1\u5165 ${fmt(fi)}s + \u6DE1\u51FA ${fmt(fo)}s \u8D85\u8FC7\u7247\u6BB5\u957F\u5EA6 ${fmt(clipLen)}s\uFF0C\u91CD\u53E0\u4F1A\u4EA7\u751F\u4E0D\u53EF\u89E3\u91CA\u7684\u4EA4\u53C9\u6DE1\u5316`
    );
  }
  if (loop.enabled) {
    if (!isNum(loop.inPoint) || !isNum(loop.outPoint)) {
      issues.push("\u5FAA\u73AF\u5165/\u51FA\u70B9\u5FC5\u987B\u662F\u6709\u9650\u6570\u503C");
    } else {
      if (loop.inPoint < inPoint - CLIP_EPS) issues.push("\u5FAA\u73AF\u5165\u70B9\u8D8A\u8FC7\u7247\u6BB5\u5165\u70B9\uFF08\u8D8A\u754C\uFF09");
      if (loop.outPoint > outPoint + CLIP_EPS) issues.push("\u5FAA\u73AF\u51FA\u70B9\u8D8A\u8FC7\u7247\u6BB5\u51FA\u70B9\uFF08\u8D8A\u754C\uFF09");
      if (loop.outPoint <= loop.inPoint + CLIP_EPS) issues.push("\u5FAA\u73AF\u533A\u95F4\u5FC5\u987B\u4E3A\u6B63\u957F\u5EA6");
      const loopLen = loop.outPoint - loop.inPoint;
      if (fi + fo > loopLen + CLIP_EPS) {
        issues.push(
          `\u5FAA\u73AF\u533A\u95F4\u957F\u5EA6 ${fmt(loopLen)}s \u5BB9\u4E0D\u4E0B\u6DE1\u5165+\u6DE1\u51FA ${fmt(fi + fo)}s\uFF08\u91CD\u53E0\u4F1A\u4EA7\u751F\u4E0D\u53EF\u89E3\u91CA\u7684\u4EA4\u53C9\u6DE1\u5316\uFF09`
        );
      }
    }
  }
  return issues;
}
function assertValidClip(draft, duration) {
  const issues = validateClipDraft(draft, duration);
  if (issues.length) throw new ClipValidationError(issues);
}
function clipLength(clip) {
  return clip.outPoint - clip.inPoint;
}
function fadeGain(curve, p) {
  const x = Math.min(1, Math.max(0, p));
  if (curve === "equalPower") {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return Math.cos((1 - x) * Math.PI / 2);
  }
  return x;
}
function fmt(t) {
  return (Math.round(t * 1e3) / 1e3).toString();
}
var CLIP_EPS, ClipValidationError, isNum;
var init_clip = __esm({
  "src/lib/clip.ts"() {
    "use strict";
    CLIP_EPS = 1 / 24e3;
    ClipValidationError = class extends Error {
      issues;
      constructor(issues) {
        super(issues.join("\uFF1B"));
        this.name = "ClipValidationError";
        this.issues = issues;
      }
    };
    isNum = (n) => typeof n === "number" && Number.isFinite(n);
  }
});

// src/lib/audioEngine.ts
var audioEngine_exports = {};
__export(audioEngine_exports, {
  AudioEngine: () => AudioEngine,
  ClipError: () => ClipError,
  DecodeError: () => DecodeError
});
function localUp(yaw, pitch) {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return {
    x: -sp * Math.sin(yaw),
    y: cp,
    z: sp * Math.cos(yaw)
  };
}
var ClipError, DecodeError, AudioEngine;
var init_audioEngine = __esm({
  "src/lib/audioEngine.ts"() {
    "use strict";
    init_spatial();
    init_samples();
    init_clip();
    ClipError = class extends Error {
      trackId;
      clipId;
      constructor(trackId, message, clipId) {
        super(message);
        this.name = "ClipError";
        this.trackId = trackId;
        this.clipId = clipId;
      }
    };
    DecodeError = class extends Error {
      trackId;
      constructor(trackId, message) {
        super(message);
        this.name = "DecodeError";
        this.trackId = trackId;
      }
    };
    AudioEngine = class {
      ctx = null;
      unlock = "locked";
      busGain = null;
      masterGain = null;
      soloBus = null;
      muteBus = null;
      analyser = null;
      timeDomainBuf = new Float32Array(new ArrayBuffer(8192));
      peakWorklet = null;
      workletFailed = false;
      voices = /* @__PURE__ */ new Map();
      buffers = /* @__PURE__ */ new Map();
      pendingFiles = /* @__PURE__ */ new Map();
      /** 每轨最多一个片段播放；逐段都在同一个 AudioContext 时钟上调度 */
      clipPlays = /* @__PURE__ */ new Map();
      spatial = null;
      anySolo = false;
      unlockListeners = /* @__PURE__ */ new Set();
      levelListeners = /* @__PURE__ */ new Set();
      endedListeners = /* @__PURE__ */ new Set();
      rafHandle = 0;
      clipLatchL = false;
      clipLatchR = false;
      lastPeak = { l: 0, r: 0, clipL: false, clipR: false };
      onUnlock(fn) {
        this.unlockListeners.add(fn);
        fn(this.unlock);
        return () => {
          this.unlockListeners.delete(fn);
        };
      }
      onLevels(fn) {
        this.levelListeners.add(fn);
        return () => {
          this.levelListeners.delete(fn);
        };
      }
      onEnded(fn) {
        this.endedListeners.add(fn);
        return () => {
          this.endedListeners.delete(fn);
        };
      }
      emitUnlock() {
        this.unlockListeners.forEach((fn) => fn(this.unlock));
      }
      /** 必须在用户手势中调用；与“未解锁”分别上报明确的失败状态 */
      async resume() {
        if (this.unlock === "unlocked" && this.ctx) {
          if (this.ctx.state === "suspended") await this.ctx.resume();
          return;
        }
        this.unlock = "unlocking";
        this.emitUnlock();
        try {
          const Ctor = window.AudioContext ?? window.webkitAudioContext;
          if (!Ctor) throw new Error("\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u652F\u6301 Web Audio API");
          const ctx = new Ctor();
          this.ctx = ctx;
          this.buildGraph(ctx);
          if (ctx.state === "suspended") await ctx.resume();
          if (ctx.state !== "running") {
            throw new Error("AudioContext \u88AB\u6D4F\u89C8\u5668\u7B56\u7565\u963B\u6B62\uFF0C\u672A\u80FD\u8FDB\u5165 running \u72B6\u6001");
          }
          this.unlock = "unlocked";
          this.emitUnlock();
          this.startMeterLoop();
          void this.ensurePeakWorklet(ctx);
        } catch (err) {
          this.unlock = "failed";
          this.emitUnlock();
          throw err;
        }
      }
      buildGraph(ctx) {
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
        this.masterGain.connect(this.analyser);
        this.analyser.connect(ctx.destination);
      }
      /**
       * 峰值/削波检测器串联在 masterGain 之后、destination 之前的真实输出链上，
       * 逐采样扫描。Worklet 源码以 Blob 注入，无需额外网络资源。
       */
      async ensurePeakWorklet(ctx) {
        if (this.peakWorklet || this.workletFailed) return !!this.peakWorklet;
        try {
          const workletSource = `
class PeakMeterProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const in0 = inputs[0];
    const out0 = outputs[0];
    if (!in0 || in0.length === 0) {
      // \u4E0A\u6E38\u9759\u9ED8\u4F18\u5316\u65F6\u8F93\u51FA\u4FDD\u6301\u96F6\u586B\u5145\u5373\u53EF
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
      if (ol) ol[i] = vl; // \u5FC5\u987B\u663E\u5F0F\u900F\u4F20\uFF0C\u5426\u5219\u8F93\u51FA\u9759\u97F3
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
          const blob = new Blob([workletSource], { type: "application/javascript" });
          const url = URL.createObjectURL(blob);
          try {
            await ctx.audioWorklet.addModule(url);
          } finally {
            URL.revokeObjectURL(url);
          }
          const node = new AudioWorkletNode(ctx, "peak-meter", {
            // 节点串在真实输出链上：必须保持立体声直通，避免被下混成单声道
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2]
          });
          node.channelCount = 2;
          node.channelInterpretation = "speakers";
          this.masterGain.disconnect();
          this.masterGain.connect(node);
          this.analyser.disconnect();
          node.connect(this.analyser);
          this.analyser.connect(ctx.destination);
          node.port.onmessage = (e) => {
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
      startMeterLoop() {
        const tick = () => {
          if (!this.peakWorklet && this.analyser) {
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
              clipR: this.clipLatchR
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
      pumpScheduler() {
        if (!this.ctx || this.unlock !== "unlocked") return;
        const now = this.ctx.currentTime;
        const LEAD = 0.3;
        for (const [trackId, play] of this.clipPlays) {
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
              this.scheduleAhead(trackId, stream, play.armed ? play.boundary : null);
            }
            if (stream.finished && stream.slices.length === 0 && play.outgoing.length === 0) {
              const voice = this.voices.get(trackId);
              if (voice) voice.playing = false;
              this.finishClipPlay(trackId, play);
              continue;
            }
          }
          if (play.armed && play.boundary != null && play.stream && play.boundary <= now + LEAD) {
            const boundary = play.boundary;
            const oldStream = play.stream;
            const kept = oldStream.slices.filter((s) => s.endAt <= boundary + CLIP_EPS);
            const dropped = oldStream.slices.filter((s) => s.endAt > boundary + CLIP_EPS);
            for (const s of dropped) this.teardownSlice(s);
            play.outgoing.push(...kept);
            const next = play.armed;
            play.armed = null;
            play.boundary = null;
            this.startStream(trackId, next, 0, boundary);
          }
        }
      }
      teardownSlice(s) {
        try {
          s.source.onended = null;
          s.source.stop();
        } catch {
        }
        s.source.disconnect();
        s.sliceGain.disconnect();
      }
      finishClipPlay(trackId, play) {
        play.stream = null;
        play.outgoing = [];
        if (!play.endedNotified) {
          play.endedNotified = true;
          this.endedListeners.forEach((fn) => fn(trackId));
        }
        this.clipPlays.delete(trackId);
      }
      // ---------- 全局参数 ----------
      setSpatialSettings(s) {
        this.spatial = s;
        if (!this.ctx) return;
        for (const v of this.voices.values()) {
          v.panner.distanceModel = s.distanceModel;
          v.panner.refDistance = s.refDistance;
          v.panner.rolloffFactor = s.rolloffFactor;
          v.panner.maxDistance = s.maxDistance;
        }
      }
      setBusGain(g2) {
        if (this.busGain && this.ctx) {
          this.busGain.gain.setTargetAtTime(g2, this.ctx.currentTime, 0.01);
        }
      }
      setMasterGain(g2) {
        if (this.masterGain && this.ctx) {
          this.masterGain.gain.setTargetAtTime(g2, this.ctx.currentTime, 0.01);
        }
      }
      /** 听者位置/朝向；朝向定义与 spatial.ts、Three.js 相机严格一致 */
      setListener(l) {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        const f = forwardVector(l.yaw, l.pitch);
        const u = localUp(l.yaw, l.pitch);
        const li = this.ctx.listener;
        const set = (p, v) => {
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
      async ensureTrack(track) {
        if (!this.ctx || this.unlock !== "unlocked") return;
        let buffer = this.buffers.get(track.id);
        if (!buffer) {
          if (track.sourceType === "file") {
            const blob = this.pendingFiles.get(track.id);
            if (!blob) return;
            try {
              const arr = await blob.arrayBuffer();
              buffer = await this.ctx.decodeAudioData(arr.slice(0));
            } catch (err) {
              throw new DecodeError(
                track.id,
                `\u97F3\u9891\u89E3\u7801\u5931\u8D25\uFF1A${err instanceof Error ? err.message : "\u4E0D\u652F\u6301\u7684\u7F16\u7801\u6216\u6587\u4EF6\u635F\u574F"}`
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
      setFileBlob(trackId, blob) {
        this.pendingFiles.set(trackId, blob);
      }
      dropBuffer(trackId) {
        this.buffers.delete(trackId);
      }
      createVoice(track, buffer) {
        const ctx = this.ctx;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = track.loop;
        const trackGain = ctx.createGain();
        trackGain.gain.value = track.muted ? 0 : track.gain;
        const clipGain = ctx.createGain();
        clipGain.gain.value = 1;
        const panner = new PannerNode(ctx, {
          panningModel: "HRTF",
          distanceModel: this.spatial?.distanceModel ?? "inverse",
          refDistance: this.spatial?.refDistance ?? 1,
          rolloffFactor: this.spatial?.rolloffFactor ?? 1,
          maxDistance: this.spatial?.maxDistance ?? 100,
          positionX: track.position.x,
          positionY: track.position.y,
          positionZ: track.position.z
        });
        if (buffer.numberOfChannels <= 1) {
          source.connect(trackGain);
        } else {
          const splitter = ctx.createChannelSplitter(buffer.numberOfChannels);
          source.connect(splitter);
          const ch = Math.min(track.channel, buffer.numberOfChannels - 1);
          splitter.connect(trackGain, ch);
        }
        trackGain.connect(clipGain);
        clipGain.connect(panner);
        const audible = this.shouldBeAudible(track);
        panner.connect(audible ? this.soloBus : this.muteBus);
        const voice = {
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
          duration: buffer.duration
        };
        source.onended = () => {
          if (!voice.playing) return;
          if (this.clipPlays.has(track.id)) return;
          const latest = voice.spec;
          voice.playing = false;
          voice.consumed = true;
          voice.offset = 0;
          const fresh = this.createVoice(latest, buffer);
          fresh.offset = 0;
          this.voices.set(track.id, fresh);
          this.endedListeners.forEach((fn) => fn(track.id));
        };
        return voice;
      }
      shouldBeAudible(track) {
        if (track.muted) return false;
        if (this.anySolo) return track.solo;
        return true;
      }
      /** 实时参数更新：不触碰 source 节点 —— 移动声源不会重启音轨 */
      updateVoiceLive(voice, track) {
        const ctx = this.ctx;
        const t = ctx.currentTime;
        const tau = Math.max(5e-3, this.spatial?.positionTimeConstant ?? 0.05);
        voice.panner.positionX.setTargetAtTime(track.position.x, t, tau);
        voice.panner.positionY.setTargetAtTime(track.position.y, t, tau);
        voice.panner.positionZ.setTargetAtTime(track.position.z, t, tau);
        voice.panner.distanceModel = this.spatial?.distanceModel ?? voice.panner.distanceModel;
        voice.trackGain.gain.setTargetAtTime(track.muted ? 0 : track.gain, t, 0.01);
        if (voice.source.loop !== track.loop) voice.source.loop = track.loop;
        const audible = this.shouldBeAudible(track);
        if (audible !== voice.audiblyRouted) {
          voice.panner.disconnect();
          voice.panner.connect(audible ? this.soloBus : this.muteBus);
          voice.audiblyRouted = audible;
        }
        voice.spec = track;
      }
      /** 静音/独奏变化：重新评估全部路由（增益本身在 updateVoiceLive 中已设置） */
      reevaluateRouting(tracks) {
        this.anySolo = tracks.some((t) => t.solo);
        if (!this.ctx) return;
        for (const tr of tracks) {
          const v = this.voices.get(tr.id);
          if (!v) continue;
          const audible = this.shouldBeAudible(tr);
          if (audible !== v.audiblyRouted) {
            v.panner.disconnect();
            v.panner.connect(audible ? this.soloBus : this.muteBus);
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
      syncTracks(tracks) {
        if (!this.ctx) return;
        this.anySolo = tracks.some((t) => t.solo);
        for (const tr of tracks) {
          const v = this.voices.get(tr.id);
          if (v) this.updateVoiceLive(v, tr);
        }
      }
      getChannelCount(trackId) {
        return this.buffers.get(trackId)?.numberOfChannels ?? null;
      }
      /**
       * 重建声轨输入图（切换立体声文件的 L/R 声道时使用）。
       * 保持播放偏移；若原本在播放，从同一位置继续（声道选择本身不属于“移动”）。
       */
      async rebuildVoiceGraph(track) {
        await this.ensureTrack(track);
        const old = this.voices.get(track.id);
        const buf = this.buffers.get(track.id);
        if (!old || !buf) return;
        const wasPlaying = old.playing;
        const offset = wasPlaying ? this.currentOffset(old) : old.offset;
        const nv = this.replaceVoice(old, track, buf, offset);
        if (wasPlaying) {
          nv.source.start(this.ctx.currentTime, offset);
          nv.startedAt = this.ctx.currentTime;
          nv.playing = true;
          nv.consumed = true;
        }
      }
      // ---------- 传输控制 ----------
      async playTrack(track) {
        const activeClip = track.activeClipId ? track.clips.find((c) => c.id === track.activeClipId) : void 0;
        if (activeClip) {
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
          const buf = this.buffers.get(track.id);
          voice = this.replaceVoice(voice, track, buf, voice.offset);
        }
        const ctx = this.ctx;
        voice.source.start(ctx.currentTime, voice.offset % voice.duration);
        voice.startedAt = ctx.currentTime;
        voice.playing = true;
        voice.consumed = true;
      }
      pauseTrack(track) {
        if (this.pauseClip(track)) return;
        const voice = this.voices.get(track.id);
        if (!voice || !voice.playing) return;
        voice.offset = this.currentOffset(voice);
        this.replaceVoice(voice, track, this.buffers.get(track.id), voice.offset);
      }
      stopTrack(track) {
        if (this.stopClip(track)) return;
        const voice = this.voices.get(track.id);
        if (!voice) return;
        if (voice.playing || voice.consumed) {
          this.replaceVoice(voice, track, this.buffers.get(track.id), 0);
        } else {
          voice.offset = 0;
        }
      }
      /** 跳转：offsetSec 秒处；autoplay=true 时立即继续播放。片段播放时在片段本地时间轴上跳转 */
      async seekTrack(track, offsetSec, autoplay) {
        const targetId = this.clipPlays.get(track.id)?.clipId ?? track.activeClipId;
        const clip = targetId ? track.clips.find((c) => c.id === targetId) : void 0;
        if (clip) {
          await this.seekClip(track, clip.id, offsetSec, autoplay);
          return;
        }
        await this.ensureTrack(track);
        const voice = this.voices.get(track.id);
        const buf = this.buffers.get(track.id);
        if (!voice || !buf) return;
        const offset = track.loop ? (offsetSec % buf.duration + buf.duration) % buf.duration : Math.min(Math.max(0, offsetSec), buf.duration);
        const nv = this.replaceVoice(voice, track, buf, offset);
        if (autoplay) {
          nv.source.start(this.ctx.currentTime, offset);
          nv.startedAt = this.ctx.currentTime;
          nv.playing = true;
          nv.consumed = true;
        }
      }
      /**
       * 停止旧节点并按最新参数重建（仅用于暂停/停止/跳转）。
       * 位置移动严禁走此路径。
       */
      replaceVoice(old, track, buffer, offset) {
        try {
          old.source.onended = null;
          old.source.stop();
        } catch {
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
      currentOffset(v) {
        let p = v.offset + (this.ctx.currentTime - v.startedAt);
        p = v.spec.loop ? (p % v.duration + v.duration) % v.duration : Math.min(p, v.duration);
        return p;
      }
      removeTrack(trackId) {
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
      getProgress(trackId) {
        const clip = this.getClipProgress(trackId);
        if (clip) return clip.current;
        const v = this.voices.get(trackId);
        if (!v) return null;
        return v.playing ? this.currentOffset(v) : v.offset;
      }
      getDuration(trackId) {
        return this.buffers.get(trackId)?.duration ?? null;
      }
      isPlaying(trackId) {
        if (this.clipPlays.has(trackId)) return true;
        return this.voices.get(trackId)?.playing ?? false;
      }
      /** 当前播放/暂停挂起的片段 id；整轨播放时为 null */
      playingClipId(trackId) {
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
      async playClip(track, clip) {
        await this.ensureTrack(track);
        const buf = this.buffers.get(track.id);
        if (!buf) {
          throw new ClipError(
            track.id,
            track.status === "decode-error" ? `\u539F\u59CB\u6587\u4EF6\u89E3\u7801\u5931\u8D25\uFF0C\u7247\u6BB5\u4E0D\u53EF\u8BD5\u542C\uFF1A${track.errorMessage ?? ""}` : "\u539F\u59CB\u97F3\u9891\u5C1A\u672A\u5C31\u7EEA\uFF0C\u7247\u6BB5\u6682\u4E0D\u53EF\u8BD5\u542C",
            clip.id
          );
        }
        if (clip.sourceDuration != null && Math.abs(buf.duration - clip.sourceDuration) > CLIP_EPS) {
          throw new ClipError(
            track.id,
            `\u539F\u6587\u4EF6\u65F6\u957F\u5DF2\u53D8\u5316\uFF08\u8BB0\u5F55 ${clip.sourceDuration.toFixed(3)}s\uFF0C\u5B9E\u9645 ${buf.duration.toFixed(3)}s\uFF09\uFF0C\u7247\u6BB5\u8FB9\u754C\u9700\u8981\u91CD\u65B0\u5BA1\u9605`,
            clip.id
          );
        }
        assertValidClip(clip, buf.duration);
        const play = this.clipPlays.get(track.id);
        if (play) {
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
          endedNotified: false
        });
        this.startStream(track.id, clip, 0, this.ctx.currentTime);
      }
      /**
       * 播放中提交的新边界/淡化：只在明确的安全边界（当前可闻段结束）生效。
       * 边界之后的预排段立即拆除（尚未发声）；当前可闻段保留到边界自然结束；
       * 新流节点提前创建、源 start(boundary) 由音频线程在边界精确起播，
       * 不 stop 任何正在发声的源，也不重启无关轨，杜绝双重播放。
       * 暂停态（无流）不属于播放中：直接把新描述记为恢复目标。
       */
      armClip(trackId, next) {
        const play = this.clipPlays.get(trackId);
        if (!play) return;
        const buf = this.buffers.get(trackId);
        if (!buf) throw new ClipError(trackId, "\u539F\u59CB\u97F3\u9891\u5C1A\u672A\u5C31\u7EEA\uFF0C\u65E0\u6CD5\u5E94\u7528\u7247\u6BB5\u4FEE\u6539", next.id);
        assertValidClip(next, buf.duration);
        if (!play.stream) {
          play.clipId = next.id;
          play.armed = null;
          play.boundary = null;
          play.resumeLocal = Math.min(play.resumeLocal, clipLength(next) - CLIP_EPS);
          return;
        }
        const now = this.ctx.currentTime;
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
          return;
        }
        const audible = play.stream.slices.find((s) => now >= s.startAt && now < s.endAt);
        const boundary = audible ? audible.endAt : play.stream.slices[0]?.endAt ?? now;
        const keep = play.stream.slices.filter((s) => s.endAt <= boundary + CLIP_EPS);
        const drop = play.stream.slices.filter((s) => s.endAt > boundary + CLIP_EPS);
        for (const s of drop) this.teardownSlice(s);
        play.armed = next;
        play.clipId = next.id;
        play.boundary = boundary;
        if (boundary <= now + 0.3) {
          play.stream.slices = keep;
          play.stream.finished = true;
          play.outgoing.push(...keep);
          play.armed = null;
          play.boundary = null;
          this.startStream(trackId, next, 0, Math.max(now, boundary));
        } else {
          play.stream.slices = keep;
          play.stream.cursor = keep.reduce((m, s) => Math.max(m, s.localEnd), 0);
          this.scheduleAhead(trackId, play.stream, boundary);
        }
        this.pumpScheduler();
      }
      /** 停止该轨的片段播放（清空调度，不等边界） */
      clearClipPlay(trackId) {
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
      startStream(trackId, clip, startLocal, startAt) {
        const voice = this.voices.get(trackId);
        if (!voice) return;
        const stream = { clip, slices: [], cursor: startLocal, finished: false };
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
      scheduleAhead(trackId, stream, stopAt) {
        const horizon = this.ctx.currentTime + 0.3;
        const limit = stopAt ?? Infinity;
        let guard = 0;
        const looping = stream.clip.loop.enabled;
        while (!stream.finished && guard < 4096) {
          const lastEnd = this.streamLastEnd(stream);
          if (lastEnd >= Math.min(horizon, limit)) {
            if (!looping || stopAt != null) break;
            const loopCount = stream.slices.length - 1;
            if (loopCount >= 3) break;
          }
          const nextStartAt = this.nextSliceStartTime(stream);
          if (nextStartAt >= limit) break;
          this.scheduleSlice(trackId, stream.clip, stream, stream.cursor, nextStartAt);
          guard++;
        }
      }
      streamLastEnd(stream) {
        const s = stream.slices[stream.slices.length - 1];
        return s ? s.endAt : -Infinity;
      }
      /** 下一段的起始绝对时间 = 最后一段结束时间；无段时为当前时刻 */
      nextSliceStartTime(stream) {
        const last = stream.slices[stream.slices.length - 1];
        return last ? last.endAt : this.ctx.currentTime;
      }
      /**
       * 排程一个播放段。
       * 首遍区域 = 完整片段 [inPoint, outPoint)；循环区域 = [loopIn, loopOut)。
       * 每段从“区域内位置”regionPos 播到区域结尾；淡化锚定在区域位置上，
       * 因此每次循环都有同样的淡入淡出，首遍与循环体各自完整。
       */
      scheduleSlice(trackId, clip, stream, localStart, startAt) {
        const ctx = this.ctx;
        const voice = this.voices.get(trackId);
        const buffer = this.buffers.get(trackId);
        const len = clipLength(clip);
        const firstPass = localStart < len - CLIP_EPS * 2;
        let regionStart;
        let regionEnd;
        let regionPos;
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
        source.loop = false;
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
        source.onended = () => {
          try {
            source.disconnect();
          } catch {
          }
          try {
            sliceGain.disconnect();
          } catch {
          }
        };
        this.applySliceEnvelope(sliceGain, clip, startAt, regionPos, regionLen);
        const consumedLocal = regionLen - regionPos;
        const localEnd = localStart + consumedLocal;
        const slice = {
          source,
          sliceGain,
          startAt,
          endAt,
          localStart,
          localEnd
        };
        stream.slices.push(slice);
        stream.cursor = localEnd;
        if (!clip.loop.enabled) stream.finished = true;
      }
      /**
       * 写入一段的淡入/淡出自动化（锚定区域位置）。
       * 用密集等功率/线性曲线，保证从区域内部起播（seek/恢复）时起点包络连续。
       */
      applySliceEnvelope(gain, clip, startAt, regionPos, regionLen) {
        const param = gain.gain;
        param.cancelScheduledValues(startAt);
        const N = 96;
        const envAt = (p) => {
          let g2 = 1;
          if (clip.fadeIn.length > 0 && p < clip.fadeIn.length) {
            g2 = Math.min(g2, fadeGain(clip.fadeIn.curve, p / clip.fadeIn.length));
          }
          const tail = regionLen - p;
          if (clip.fadeOut.length > 0 && tail < clip.fadeOut.length) {
            g2 = Math.min(g2, fadeGain(clip.fadeOut.curve, 1 - tail / clip.fadeOut.length));
          }
          return Math.max(1e-4, g2);
        };
        const span = Math.max(CLIP_EPS, regionLen - regionPos);
        const curve = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          const p = regionPos + span * i / (N - 1);
          curve[i] = envAt(Math.min(p, regionLen - CLIP_EPS));
        }
        param.setValueCurveAtTime(curve, startAt, span);
      }
      /** 当前播放到的片段本地位置（秒） */
      clipCurrentLocal(play) {
        const stream = play.stream;
        const now = this.ctx.currentTime;
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
      getClipProgress(trackId) {
        const play = this.clipPlays.get(trackId);
        if (!play) return null;
        const clip = play.stream?.clip ?? play.armed ?? this.findClipById(trackId, play.clipId);
        if (!clip) return null;
        const local = play.stream ? this.clipCurrentLocal(play) : play.outgoing.length ? this.outgoingLocal(play) : play.resumeLocal;
        return { current: local, duration: clipLength(clip), clipId: play.clipId };
      }
      findClipById(trackId, clipId) {
        const t = this.voices.get(trackId)?.spec;
        return t?.clips.find((c) => c.id === clipId) ?? null;
      }
      outgoingLocal(play) {
        const now = this.ctx.currentTime;
        const s = [...play.outgoing].sort((a, b) => b.endAt - a.endAt)[0];
        const into = Math.max(0, now - s.startAt);
        return Math.min(s.localEnd, s.localStart + into);
      }
      pauseClip(track) {
        const play = this.clipPlays.get(track.id);
        if (!play) return false;
        const local = play.stream ? this.clipCurrentLocal(play) : play.outgoing.length ? this.outgoingLocal(play) : play.resumeLocal;
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
      async resumeClip(track) {
        const play = this.clipPlays.get(track.id);
        if (!play || play.stream) return;
        const clip = this.findClip(track, play.clipId);
        if (!clip) {
          this.clipPlays.delete(track.id);
          throw new ClipError(track.id, "\u7247\u6BB5\u63CF\u8FF0\u5DF2\u4E0D\u5B58\u5728");
        }
        const buf = this.buffers.get(track.id);
        if (!buf) throw new ClipError(track.id, "\u539F\u59CB\u97F3\u9891\u5C1A\u672A\u5C31\u7EEA");
        assertValidClip(clip, buf.duration);
        const startLocal = this.clampLocal(clip, play.resumeLocal);
        play.endedNotified = false;
        this.startStream(track.id, clip, startLocal, this.ctx.currentTime);
      }
      stopClip(track) {
        if (!this.clipPlays.has(track.id)) return false;
        this.clearClipPlay(track.id);
        const v = this.voices.get(track.id);
        if (v) v.playing = false;
        return true;
      }
      /** 片段内跳转；autoplay 语义与整轨 seek 一致 */
      async seekClip(track, clipId, localSec, autoplay) {
        const clip = this.findClip(track, clipId);
        if (!clip) throw new ClipError(track.id, "\u7247\u6BB5\u4E0D\u5B58\u5728", clipId);
        const buf = this.buffers.get(track.id);
        if (!buf) throw new ClipError(track.id, "\u539F\u59CB\u97F3\u9891\u5C1A\u672A\u5C31\u7EEA", clipId);
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
            endedNotified: true
            // 暂停态不触发结束通知
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
          endedNotified: false
        });
        this.startStream(track.id, clip, local, this.ctx.currentTime);
      }
      clampLocal(clip, local) {
        const len = clipLength(clip);
        const l = Math.min(Math.max(0, local), len - CLIP_EPS);
        return l;
      }
      findClip(track, clipId) {
        return track.clips.find((c) => c.id === clipId);
      }
      dispose() {
        cancelAnimationFrame(this.rafHandle);
        for (const id of [...this.voices.keys()]) this.removeTrack(id);
        void this.ctx?.close();
        this.ctx = null;
        this.unlock = "locked";
      }
    };
  }
});

// test/engine.test.ts
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
var FakeAudioParam = class {
  value;
  events = [];
  curves = [];
  constructor(v) {
    this.value = v;
  }
  setTargetAtTime(v, time, tc) {
    this.value = v;
    this.events.push({ time, value: v, tc });
  }
  setValueAtTime(v, _time) {
    this.value = v;
  }
  linearRampToValueAtTime(v, _time) {
    this.value = v;
  }
  setValueCurveAtTime(data, time, duration) {
    this.curves.push({ time, data, duration });
    this.value = data[0];
  }
  cancelScheduledValues(_time) {
    this.curves = [];
  }
};
var FakeNode = class {
  connects = [];
  disconnected = false;
  connectedFrom = [];
  connect(node, out, inp) {
    const target = node.input ?? node;
    this.connects.push({ node: target, out, inp });
    target.connectedFrom.push(this);
    return target;
  }
  disconnect() {
    this.connects = [];
    this.disconnected = true;
  }
};
var FakeGain = class extends FakeNode {
  gain = new FakeAudioParam(1);
};
var FakeStereoPanner = class extends FakeNode {
};
var FakeDestination = class extends FakeNode {
};
var FakePanner = class extends FakeNode {
  panningModel = "HRTF";
  distanceModel = "inverse";
  refDistance = 1;
  rolloffFactor = 1;
  maxDistance = 100;
  positionX = new FakeAudioParam(0);
  positionY = new FakeAudioParam(0);
  positionZ = new FakeAudioParam(0);
  positionTimeConstant = 0;
  orientationX = new FakeAudioParam(1);
  constructor(_ctx, opts = {}) {
    super();
    Object.assign(this, opts);
    if (opts.positionX !== void 0) this.positionX = new FakeAudioParam(opts.positionX);
    if (opts.positionY !== void 0) this.positionY = new FakeAudioParam(opts.positionY);
    if (opts.positionZ !== void 0) this.positionZ = new FakeAudioParam(opts.positionZ);
  }
};
var FakeBufferSource = class extends FakeNode {
  buffer = null;
  loop = false;
  started = [];
  /** 无参/即时 stop 次数（强停）；stop(未来时刻) 为预定停止，单独计数 */
  stopped = 0;
  scheduledStops = [];
  onended = null;
  start(time, offset = 0, duration) {
    this.started.push({ time, offset, duration });
  }
  stop(time) {
    if (time == null) this.stopped++;
    else this.scheduledStops.push(time);
  }
};
var FakeBuffer = class {
  duration;
  numberOfChannels;
  length;
  sampleRate;
  data;
  constructor(ch, length, sr, duration) {
    this.numberOfChannels = ch;
    this.length = length;
    this.sampleRate = sr;
    this.duration = duration;
    this.data = Array.from({ length: ch }, () => new Float32Array(length));
  }
  getChannelData(i) {
    return this.data[i];
  }
};
var FakeSplitter = class extends FakeNode {
  constructor(channels) {
    super();
    this.channels = channels;
  }
};
var FakeMerger = class extends FakeNode {
};
var FakeListener = class {
  positionX = new FakeAudioParam(0);
  positionY = new FakeAudioParam(0);
  positionZ = new FakeAudioParam(0);
  forwardX = new FakeAudioParam(0);
  forwardY = new FakeAudioParam(0);
  forwardZ = new FakeAudioParam(-1);
  upX = new FakeAudioParam(0);
  upY = new FakeAudioParam(1);
  upZ = new FakeAudioParam(0);
};
var FakeAnalyser = class extends FakeNode {
  fftSize = 2048;
  getFloatTimeDomainData(arr) {
    arr.fill(0);
  }
};
var FakeAudioContext = class {
  state = "running";
  currentTime = 0;
  playbackRate = { value: 1 };
  destination = new FakeDestination();
  listener = new FakeListener();
  sampleRate = 48e3;
  audioWorklet = {
    addModule: async () => {
      throw new Error("worklet unavailable in test");
    }
  };
  createGain() {
    return new FakeGain();
  }
  createBufferSource() {
    return new FakeBufferSource();
  }
  createBuffer(ch, length, sr) {
    return new FakeBuffer(ch, length, sr, length / sr);
  }
  createChannelSplitter(ch) {
    return new FakeSplitter(ch);
  }
  createChannelMerger(ch) {
    return new FakeMerger();
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  createStereoPanner() {
    return new FakeStereoPanner();
  }
  async resume() {
    this.state = "running";
  }
  async decodeAudioData(buf) {
    const text = new TextDecoder().decode(buf);
    if (text === "BAD") throw new Error("EncodingError: fake bad file");
    return new FakeBuffer(1, 48e3, 48e3, 1);
  }
  async close() {
  }
};
var g = globalThis;
g.AudioContext = FakeAudioContext;
g.requestAnimationFrame = (fn) => {
  return setTimeout(() => fn(0), 16);
};
g.cancelAnimationFrame = (id) => clearTimeout(id);
g.window = globalThis;
g.PannerNode = FakePanner;
var { AudioEngine: AudioEngine2, ClipError: ClipError2, DecodeError: DecodeError2 } = await Promise.resolve().then(() => (init_audioEngine(), audioEngine_exports));
var { createSampleBuffer: createSampleBuffer2 } = await Promise.resolve().then(() => (init_samples(), samples_exports));
function baseTrack(over = {}) {
  return {
    id: "t1",
    name: "T",
    sourceType: "tone",
    loop: false,
    muted: false,
    solo: false,
    gain: 0.8,
    channel: 0,
    color: "#fff",
    position: { x: 2, y: 0, z: 0 },
    status: "pending",
    clips: [],
    activeClipId: null,
    ...over
  };
}
describe("AudioEngine \u56FE\u884C\u4E3A\uFF08\u6A21\u62DF\u73AF\u5883\uFF09", () => {
  let engine;
  beforeEach(() => {
    engine = new AudioEngine2();
  });
  afterEach(() => {
    engine.dispose();
  });
  it("resume \u89E3\u9501\uFF1BsetListener \u5199\u5165\u4E0E\u7A7A\u95F4\u6570\u5B66\u4E00\u81F4\u7684\u671D\u5411", async () => {
    await engine.resume();
    assert.equal(engine.unlock, "unlocked");
    engine.setListener({
      position: { x: 0, y: 0, z: 3 },
      yaw: Math.PI / 2,
      // 右转 → forward (+1,0,0)
      pitch: 0,
      earHeight: 0
    });
    const li = engine.ctx.listener;
    assert.ok(Math.abs(li.forwardX.value - 1) < 1e-6);
    assert.ok(Math.abs(li.forwardZ.value) < 1e-6);
    assert.ok(Math.abs(li.upY.value - 1) < 1e-6);
    assert.ok(Math.abs(li.positionZ.value - 3) < 1e-6);
  });
  it("\u58F0\u8F68\u94FE\u8DEF\u4E3A source\u2192trackGain\u2192HRTF panner\u2192soloBus\u2192\u2026\u2192destination\uFF1B\u8DDD\u79BB\u6A21\u578B\u53C2\u6570\u4E0B\u53D1", async () => {
    await engine.resume();
    engine.setSpatialSettings({
      distanceModel: "exponential",
      refDistance: 2,
      rolloffFactor: 1.5,
      maxDistance: 25,
      positionTimeConstant: 0.05,
      hrtfIR: "none"
    });
    const track = baseTrack();
    await engine.ensureTrack(track);
    const voices = engine.voices;
    const v = voices.get("t1");
    assert.equal(v.panner.panningModel, "HRTF");
    assert.equal(v.panner.distanceModel, "exponential");
    assert.equal(v.panner.refDistance, 2);
    assert.equal(v.panner.rolloffFactor, 1.5);
    assert.equal(v.panner.maxDistance, 25);
    assert.ok(Math.abs(v.panner.positionX.value - 2) < 1e-9);
    assert.ok(v.source.connects.some((c) => c.node === v.trackGain));
    assert.ok(v.trackGain.connects.some((c) => c.node === v.clipGain));
    assert.ok(v.clipGain.connects.some((c) => c.node === v.panner));
    const soloBus = engine.soloBus;
    assert.ok(v.panner.connects.some((c) => c.node === soloBus));
  });
  it("\u9759\u97F3\u771F\u5B9E\u628A trackGain \u7F6E 0\uFF1B\u72EC\u594F\u628A\u975E\u72EC\u594F\u58F0\u8F68\u5207\u5230 muteBus", async () => {
    await engine.resume();
    const a = baseTrack({ id: "a" });
    const b = baseTrack({ id: "b", position: { x: -2, y: 0, z: 0 } });
    await engine.ensureTrack(a);
    await engine.ensureTrack(b);
    const voices = engine.voices;
    const muteBus = engine.muteBus;
    engine.syncTracks([{ ...a, muted: true }, b]);
    assert.equal(voices.get("a").trackGain.gain.value, 0);
    assert.equal(voices.get("b").trackGain.gain.value, 0.8);
    engine.syncTracks([{ ...a, muted: true }, { ...b, solo: true }]);
    assert.ok(voices.get("a").panner.connects.some((c) => c.node === muteBus));
    assert.ok(
      voices.get("b").panner.connects.every((c) => c.node !== muteBus)
    );
    engine.syncTracks([{ ...a, muted: true }, b]);
    assert.ok(voices.get("a").panner.connects.some((c) => c.node === muteBus));
    assert.ok(
      voices.get("a").panner.connects.every((c) => c.node === muteBus)
    );
  });
  it("\u79FB\u52A8\u58F0\u6E90\u53EA\u5199 AudioParam\uFF0C\u7EDD\u4E0D stop/start source\uFF08\u4E0D\u91CD\u542F\u97F3\u8F68\uFF09", async () => {
    await engine.resume();
    const t = baseTrack();
    await engine.playTrack(t);
    const v = engine.voices.get("t1");
    const startsBefore = v.source.started.length;
    const stopsBefore = v.source.stopped;
    for (let i = 0; i < 10; i++) {
      engine.syncTracks([
        { ...t, position: { x: 2 + i * 0.1, y: 0.5, z: -i * 0.2 } }
      ]);
    }
    assert.ok(Math.abs(v.panner.positionX.value - 2.9) < 1e-9);
    assert.ok(Math.abs(v.panner.positionY.value - 0.5) < 1e-9);
    assert.ok(Math.abs(v.panner.positionZ.value - -1.8) < 1e-9);
    assert.equal(v.source.started.length, startsBefore);
    assert.equal(v.source.stopped, stopsBefore);
  });
  it("\u6682\u505C\u4F1A\u505C\u6B62\u5E76\u91CD\u5EFA\u8282\u70B9\u4E14\u4FDD\u7559\u504F\u79FB\uFF1B\u518D\u6B21\u64AD\u653E\u4ECE\u504F\u79FB\u5F00\u59CB", async () => {
    await engine.resume();
    const ctx = engine.ctx;
    const t = { ...baseTrack(), loop: false };
    await engine.playTrack(t);
    ctx.currentTime = 0.3;
    engine.pauseTrack(t);
    await engine.playTrack({ ...t });
    const v = engine.voices.get("t1");
    const last = v.source.started[v.source.started.length - 1];
    assert.ok(Math.abs(last.offset - 0.3) < 1e-6);
  });
  it("\u603B\u7EBF\u4E0E\u4E3B\u589E\u76CA\u771F\u5B9E\u5199\u5165\u5BF9\u5E94 GainNode", async () => {
    await engine.resume();
    engine.setBusGain(0.42);
    engine.setMasterGain(0.71);
    const bus = engine.busGain;
    const master = engine.masterGain;
    assert.ok(Math.abs(bus.gain.value - 0.42) < 1e-9);
    assert.ok(Math.abs(master.gain.value - 0.71) < 1e-9);
    const analyser = engine.analyser;
    const destination = engine.ctx.destination;
    assert.ok(analyser.connects.some((c) => c.node === destination));
  });
  it("\u574F\u6587\u4EF6\u89E3\u7801\u5931\u8D25\u629B\u51FA DecodeError\uFF0C\u4E14\u4E0D\u5F71\u54CD\u5176\u4ED6\u58F0\u8F68", async () => {
    await engine.resume();
    const bad = baseTrack({ id: "bad", sourceType: "file" });
    engine.setFileBlob("bad", new Blob([new TextEncoder().encode("BAD")], { type: "audio/x" }));
    await assert.rejects(engine.ensureTrack(bad), (err) => err instanceof DecodeError2);
    const good = baseTrack({ id: "good" });
    await engine.ensureTrack(good);
    const voices = engine.voices;
    assert.ok(voices.has("good"));
  });
  it("\u5185\u7F6E\u6837\u4F8B\u7F13\u51B2\u53EF\u7ECF\u5F15\u64CE\u5408\u6210\uFF0C\u65F6\u957F\u4E0E\u58F0\u9053\u7B26\u5408\u9884\u671F", async () => {
    await engine.resume();
    const buf = createSampleBuffer2(engine.ctx, "pulse");
    assert.equal(buf.numberOfChannels, 1);
    assert.ok(Math.abs(buf.duration - 1.6) < 1e-6);
  });
});
function makeClip(over = {}) {
  return {
    id: "clip1",
    name: "\u7247\u6BB5",
    trackId: "t1",
    inPoint: 0.5,
    outPoint: 2,
    fadeIn: { length: 0.05, curve: "linear" },
    fadeOut: { length: 0.1, curve: "equalPower" },
    loop: { enabled: false, inPoint: 0.5, outPoint: 2 },
    sourceDuration: 3,
    // tone 样例时长
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over
  };
}
function clipInternals(eng) {
  return eng;
}
describe("AudioEngine \u975E\u7834\u574F\u6027\u7247\u6BB5", () => {
  let eng;
  const ctxNow = (t) => {
    eng.ctx.currentTime = t;
  };
  beforeEach(async () => {
    eng = new AudioEngine2();
    await eng.resume();
  });
  afterEach(() => eng.dispose());
  it("\u7247\u6BB5\u53EA\u5F15\u7528\u539F\u59CB\u533A\u95F4\uFF1A\u6E90\u4EE5 inPoint/\u957F\u5EA6\u8D77\u64AD\uFF0C\u6DE1\u5316\u8282\u70B9\u771F\u5B9E\u4E32\u5728 panner \u524D", async () => {
    const c = makeClip();
    const track = baseTrack({ clips: [c], activeClipId: "clip1" });
    await eng.playClip(track, c);
    eng.pumpScheduler();
    const ie = clipInternals(eng);
    const play = ie.clipPlays.get("t1");
    assert.ok(play.stream);
    assert.equal(play.stream.slices.length, 1);
    const s0 = play.stream.slices[0];
    assert.deepEqual(
      s0.source.started[s0.source.started.length - 1],
      { time: 0, offset: 0.5, duration: 1.5 }
    );
    assert.ok(s0.sliceGain.gain.curves.length >= 1);
    assert.ok(s0.sliceGain.connects.some((cn) => cn.node === ie.voices.get("t1").clipGain));
    assert.ok(ie.voices.get("t1").clipGain.connects.some((cn) => cn.node === ie.voices.get("t1").panner));
  });
  it("\u4E24\u6761\u540C\u6B65\u6837\u4F8B\u7684\u4E0D\u540C\u7247\u6BB5\u5728\u540C\u4E00 ctx \u65F6\u949F\u4E0A\u8C03\u5EA6\u4E14\u5404\u81EA\u65E0\u7F1D\uFF08\u65E0\u95F4\u9699\uFF09", async () => {
    const ca = makeClip({
      id: "a",
      trackId: "a",
      inPoint: 0.5,
      outPoint: 3,
      loop: { enabled: true, inPoint: 1, outPoint: 3 },
      sourceDuration: 4
    });
    const cb = makeClip({
      id: "b",
      trackId: "b",
      inPoint: 1,
      outPoint: 2.5,
      loop: { enabled: true, inPoint: 1.2, outPoint: 2.2 },
      sourceDuration: 4
    });
    const ta = baseTrack({ id: "a", sourceType: "duoA", clips: [ca], activeClipId: "a" });
    const tb = baseTrack({ id: "b", sourceType: "duoB", clips: [cb], activeClipId: "b" });
    await eng.playClip(ta, ca);
    await eng.playClip(tb, cb);
    eng.pumpScheduler();
    const ie = clipInternals(eng);
    const sa = ie.clipPlays.get("a").stream.slices;
    const sb = ie.clipPlays.get("b").stream.slices;
    assert.equal(sa[0].startAt, 0);
    assert.equal(sb[0].startAt, 0);
    for (const slices of [sa, sb]) {
      for (let i = 1; i < slices.length; i++) {
        assert.ok(Math.abs(slices[i].startAt - slices[i - 1].endAt) < 1e-12);
      }
    }
    const aLater = sa[sa.length - 1];
    assert.ok(Math.abs(aLater.endAt - (2.5 + (sa.length - 1) * 2)) < 1e-9);
    assert.ok(Math.abs(sa[1].source.started[0].offset - 1) < 1e-12);
    assert.ok(Math.abs(sb[1].source.started[0].offset - 1.2) < 1e-12);
  });
  it("\u64AD\u653E\u4E2D\u4FEE\u6539\u7247\u6BB5\uFF1A\u65E7\u6E90\u4E0D\u88AB\u5F3A\u505C\uFF0C\u65B0\u6E90\u5728\u5B89\u5168\u8FB9\u754C\u540C\u70B9\u8D77\u64AD\uFF0C\u4E0D\u53CC\u64AD\u3001\u4E0D\u91CD\u542F\u65E0\u5173\u8F68", async () => {
    const c = makeClip();
    const track = baseTrack({ clips: [c], activeClipId: "clip1" });
    await eng.playClip(track, c);
    eng.pumpScheduler();
    const ie = clipInternals(eng);
    const oldSource = ie.clipPlays.get("t1").stream.slices[0].source;
    const t2 = baseTrack({ id: "x", position: { x: -1, y: 0, z: 0 } });
    await eng.playTrack(t2);
    const xSource = clipInternals(eng).voices.get("x").source;
    const xStarts = xSource.started.length;
    const c2 = makeClip({ id: "clip1", inPoint: 0, outPoint: 1, sourceDuration: 3, version: 2 });
    eng.armClip("t1", c2);
    eng.pumpScheduler();
    assert.equal(oldSource.stopped, 0);
    assert.equal(ie.clipPlays.get("t1").stream.slices[0].source, oldSource);
    const allSources = () => [...ie.clipPlays].flatMap(([, p]) => [
      ...p.stream?.slices ?? [],
      ...p.outgoing ?? []
    ]);
    assert.equal(allSources().filter((s) => s.source !== oldSource).length, 0);
    ctxNow(1.3);
    eng.pumpScheduler();
    const play = ie.clipPlays.get("t1");
    assert.equal(play.armed, null);
    assert.equal(play.boundary, null);
    assert.equal(play.outgoing.length, 1);
    const ns = play.stream.slices[0];
    assert.ok(Math.abs(ns.startAt - 1.5) < 1e-9);
    assert.deepEqual(ns.source.started[0], { time: 1.5, offset: 0, duration: 1 });
    assert.equal(oldSource.stopped, 0);
    assert.equal(xSource.started.length, xStarts);
    assert.equal(xSource.stopped, 0);
    ctxNow(1.5);
    eng.pumpScheduler();
    assert.equal(play.stream.slices.length, 1);
    assert.equal(play.outgoing.length, 1);
    assert.equal(play.outgoing[0].source, oldSource);
    assert.ok(Math.abs(play.outgoing[0].endAt - play.stream.slices[0].startAt) < 1e-12);
    ctxNow(2);
    eng.pumpScheduler();
    assert.equal(play.outgoing.length, 0);
    assert.equal(play.stream.slices[0].source, ns.source);
  });
  it("\u8FB9\u754C\u5F88\u8FDC\u65F6\u6362\u6D41\u6302\u8D77\uFF1A\u65E7\u6D41\u7EE7\u7EED\u65E0\u7F1D\u7EED\u6392\uFF0C\u4E0D\u8D8A\u8FC7\u8FB9\u754C\u6392\u6BB5\uFF0C\u5230\u8FB9\u754C\u624D\u6362\u65B0\u6D41", async () => {
    const c = makeClip({
      inPoint: 0.2,
      outPoint: 2.6,
      loop: { enabled: true, inPoint: 1, outPoint: 2.6 },
      sourceDuration: 3
    });
    const track = baseTrack({ clips: [c], activeClipId: "clip1" });
    await eng.playClip(track, c);
    eng.pumpScheduler();
    const ie = clipInternals(eng);
    const old = ie.clipPlays.get("t1");
    const c2 = makeClip({ id: "clip1", inPoint: 0, outPoint: 0.5, sourceDuration: 3, version: 2 });
    eng.armClip("t1", c2);
    const armedAt = ie.clipPlays.get("t1").boundary;
    assert.ok(Math.abs(armedAt - 2.4) < 1e-9);
    assert.equal(old.stream.finished, false);
    for (const s of old.stream.slices) assert.ok(s.endAt <= 2.4 + 1e-9);
    assert.ok(old.stream.slices.some((s) => Math.abs(s.endAt - 2.4) < 1e-9));
    ctxNow(2);
    eng.pumpScheduler();
    const beforeSwitch = ie.clipPlays.get("t1");
    assert.notEqual(beforeSwitch.armed, null);
    ctxNow(2.15);
    eng.pumpScheduler();
    const atSwitch = ie.clipPlays.get("t1");
    assert.equal(atSwitch.armed, null);
    assert.ok(Math.abs(atSwitch.stream.slices[0].startAt - 2.4) < 1e-9);
    assert.deepEqual(atSwitch.stream.slices[0].source.started[0], {
      time: 2.4,
      offset: 0,
      duration: 0.5
    });
    assert.equal(atSwitch.outgoing.length, 1);
    assert.ok(Math.abs(atSwitch.outgoing[0].endAt - 2.4) < 1e-9);
  });
  it("\u975E\u6CD5\u8FB9\u754C\u5728\u64AD\u653E\u4E2D\u63D0\u4EA4\u88AB\u62D2\u7EDD\uFF08ClipValidationError\uFF09\uFF0C\u64AD\u653E\u7EE7\u7EED\u65E7\u63CF\u8FF0", async () => {
    const c = makeClip();
    const track = baseTrack({ clips: [c], activeClipId: "clip1" });
    await eng.playClip(track, c);
    eng.pumpScheduler();
    const bad = makeClip({ inPoint: 2.5, outPoint: 2.6, sourceDuration: 3 });
    assert.throws(() => eng.armClip("t1", bad));
    const oor = makeClip({ inPoint: 2.9, outPoint: 4, sourceDuration: 3 });
    assert.throws(() => eng.armClip("t1", oor));
    const s = clipInternals(eng).clipPlays.get("t1").stream.slices[0];
    assert.deepEqual(s.source.started[0], { time: 0, offset: 0.5, duration: 1.5 });
  });
  it("\u539F\u6587\u4EF6\u65F6\u957F\u53D8\u5316\u3001\u89E3\u7801\u5931\u8D25\u3001Blob \u7F3A\u5931\u5206\u522B\u62A5\u9519\uFF0C\u4E14\u4E0D\u542F\u52A8\u4EFB\u4F55\u7247\u6BB5\u6E90", async () => {
    const changed = makeClip({ sourceDuration: 2.9 });
    const tChanged = baseTrack({ clips: [changed] });
    await assert.rejects(
      eng.playClip(tChanged, changed),
      (e) => e instanceof ClipError2 && /时长已变化/.test(e.message)
    );
    assert.equal(clipInternals(eng).clipPlays.has("t1"), false);
    const bad = baseTrack({
      id: "bad",
      sourceType: "file",
      clips: [makeClip({ trackId: "bad" })]
    });
    eng.setFileBlob("bad", new Blob([new TextEncoder().encode("BAD")], { type: "audio/x" }));
    await assert.rejects(eng.playClip(bad, makeClip({ trackId: "bad" })), (e) => e instanceof DecodeError2);
    const missing = baseTrack({
      id: "miss",
      sourceType: "file",
      status: "decode-error",
      errorMessage: "\u672C\u5730\u97F3\u9891 Blob \u7F3A\u5931",
      clips: [makeClip({ trackId: "miss" })]
    });
    await assert.rejects(
      eng.playClip(missing, makeClip({ trackId: "miss" })),
      (e) => e instanceof ClipError2 && /解码失败/.test(e.message)
    );
  });
  it("\u6682\u505C\u4FDD\u7559\u7247\u6BB5\u672C\u5730\u4F4D\u7F6E\uFF0C\u6062\u590D\u4ECE\u540C\u4F4D\u7F6E\u7EED\u64AD\uFF08\u504F\u79FB=\u5165\u70B9+\u672C\u5730\u4F4D\u7F6E\uFF09", async () => {
    const c = makeClip();
    const track = baseTrack({ clips: [c], activeClipId: "clip1" });
    await eng.playTrack(track);
    eng.pumpScheduler();
    ctxNow(0.4);
    eng.pauseTrack(track);
    const ie = clipInternals(eng);
    assert.equal(ie.clipPlays.get("t1").stream, null);
    await eng.playTrack(track);
    const s = ie.clipPlays.get("t1").stream.slices[0];
    assert.ok(Math.abs(s.source.started[0].offset - 0.9) < 1e-9);
    assert.ok(Math.abs(s.source.started[0].duration - 1.1) < 1e-9);
  });
  it("\u975E\u5FAA\u73AF\u7247\u6BB5\u81EA\u7136\u7ED3\u675F\u540E\u7247\u6BB5\u64AD\u653E\u8BB0\u5F55\u6E05\u9664\u3001playing \u5F52\u4F4D", async () => {
    const c = makeClip();
    const track = baseTrack({ clips: [c], activeClipId: "clip1" });
    await eng.playClip(track, c);
    eng.pumpScheduler();
    ctxNow(2);
    eng.pumpScheduler();
    assert.equal(clipInternals(eng).clipPlays.has("t1"), false);
    assert.equal(eng.isPlaying("t1"), false);
  });
});
