var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/lib/clipEdit.ts
function validateFade(f, label, regionLen) {
  const errs = [];
  if (!f || !isNum(f.duration) || f.duration < 0) {
    errs.push(`${label}\u957F\u5EA6\u975E\u6CD5`);
    return errs;
  }
  if (f.duration > regionLen + 1e-9) {
    errs.push(`${label}\u957F\u5EA6 ${f.duration.toFixed(3)}s \u8D85\u51FA\u7247\u6BB5\u957F\u5EA6 ${regionLen.toFixed(3)}s`);
  }
  if (f.shape !== "linear" && f.shape !== "equalPower" && f.shape !== "exponential") {
    errs.push(`${label}\u66F2\u7EBF\u7C7B\u578B\u672A\u77E5`);
  }
  return errs;
}
function validateClipFields(fields, sourceDuration) {
  const reasons = [];
  const { sourceStart, sourceEnd, fadeIn, fadeOut, loop } = fields;
  if (!isNum(sourceDuration) || sourceDuration <= 0) {
    throw new ClipValidationError(["\u6E90\u65F6\u957F\u672A\u77E5\uFF0C\u5C1A\u4E0D\u80FD\u5B9A\u4E49\u7247\u6BB5"]);
  }
  if (!isNum(sourceStart)) reasons.push("\u5165\u70B9\u4E0D\u662F\u6709\u6548\u6570\u503C");
  if (!isNum(sourceEnd)) reasons.push("\u51FA\u70B9\u4E0D\u662F\u6709\u6548\u6570\u503C");
  if (reasons.length > 0) throw new ClipValidationError(reasons);
  if (sourceStart < -1e-9) reasons.push(`\u5165\u70B9 ${sourceStart.toFixed(3)}s \u8D8A\u8FC7\u6E90\u8D77\u70B9 0`);
  if (sourceEnd > sourceDuration + 1e-6) {
    reasons.push(`\u51FA\u70B9 ${sourceEnd.toFixed(3)}s \u8D8A\u8FC7\u6E90\u65F6\u957F ${sourceDuration.toFixed(3)}s`);
  }
  if (sourceEnd - sourceStart < MIN_CLIP_LENGTH) {
    reasons.push(
      `\u7247\u6BB5\u957F\u5EA6 ${(sourceEnd - sourceStart).toFixed(3)}s \u77ED\u4E8E\u6700\u5C0F\u503C ${MIN_CLIP_LENGTH}s`
    );
  }
  if (reasons.length > 0) throw new ClipValidationError(reasons);
  const regionLen = sourceEnd - sourceStart;
  reasons.push(...validateFade(fadeIn, "\u6DE1\u5165", regionLen));
  reasons.push(...validateFade(fadeOut, "\u6DE1\u51FA", regionLen));
  if (isNum(fadeIn?.duration) && isNum(fadeOut?.duration)) {
    if (fadeIn.duration + fadeOut.duration > regionLen + 1e-9) {
      reasons.push(
        `\u6DE1\u5165 ${fadeIn.duration.toFixed(3)}s \u4E0E\u6DE1\u51FA ${fadeOut.duration.toFixed(3)}s \u91CD\u53E0\uFF0C\u6784\u6210\u4E0D\u53EF\u89E3\u91CA\u7684\u4EA4\u53C9\u6DE1\u5316`
      );
    }
  }
  if (!loop || typeof loop.enabled !== "boolean") {
    reasons.push("\u5FAA\u73AF\u89C4\u5219\u7F3A\u5931");
  } else if (loop.enabled) {
    if (!isNum(loop.start)) {
      reasons.push("\u5FAA\u73AF\u70B9\u4E0D\u662F\u6709\u6548\u6570\u503C");
    } else if (loop.start < sourceStart - 1e-9 || loop.start >= sourceEnd - 1e-9) {
      reasons.push(
        `\u5FAA\u73AF\u56DE\u8DF3\u70B9 ${loop.start.toFixed(3)}s \u5FC5\u987B\u4F4D\u4E8E\u5165\u70B9 ${sourceStart.toFixed(3)}s \u4E0E\u51FA\u70B9 ${sourceEnd.toFixed(3)}s \u4E4B\u95F4`
      );
    } else {
      const introLen = loop.start - sourceStart;
      const loopLen = sourceEnd - loop.start;
      if (fadeIn.duration > introLen + 1e-9) {
        reasons.push(
          `\u6DE1\u5165 ${fadeIn.duration.toFixed(3)}s \u8D85\u8FC7\u5FAA\u73AF\u524D\u5BFC\u957F\u5EA6 ${introLen.toFixed(3)}s\uFF0C\u56DE\u7ED5\u4F1A\u622A\u65AD\u6DE1\u5165`
        );
      }
      if (fadeOut.duration > loopLen + 1e-9) {
        reasons.push(
          `\u6DE1\u51FA ${fadeOut.duration.toFixed(3)}s \u8D85\u8FC7\u5355\u6B21\u5FAA\u73AF\u957F\u5EA6 ${loopLen.toFixed(3)}s`
        );
      }
    }
    const countOk = loop.count === Number.POSITIVE_INFINITY || Number.isInteger(loop.count) && loop.count >= 1;
    if (!countOk) reasons.push("\u5FAA\u73AF\u6B21\u6570\u5FC5\u987B\u4E3A \u22651 \u7684\u6574\u6570\u6216\u6301\u7EED\u5FAA\u73AF");
    if (countOk && loop.count === Number.POSITIVE_INFINITY && fadeOut.duration > 0) {
      reasons.push("\u6301\u7EED\u5FAA\u73AF\u6CA1\u6709\u7EC8\u70B9\uFF0C\u4E0D\u80FD\u8BBE\u7F6E\u6DE1\u51FA\uFF08\u8BF7\u9650\u5B9A\u5FAA\u73AF\u6B21\u6570\u6216\u53D6\u6D88\u6DE1\u51FA\uFF09");
    }
  }
  if (reasons.length > 0) throw new ClipValidationError(reasons);
}
function clipRegionLength(clip) {
  return Math.max(0, clip.sourceEnd - clip.sourceStart);
}
function fadeShapeGain(p, shape) {
  const x = Math.min(1, Math.max(0, p));
  switch (shape) {
    case "linear":
      return x;
    case "equalPower":
      return Math.sin(Math.PI / 2 * x);
    case "exponential":
      return x <= 0 ? 0 : Math.pow(10, -3 * (1 - x));
    default:
      return x;
  }
}
function clipFadeGain(clip, timelineT) {
  const len = clipRegionLength(clip);
  if (timelineT < 0 || timelineT >= len) return 0;
  let g2 = 1;
  if (clip.fadeIn.duration > 0 && timelineT < clip.fadeIn.duration) {
    g2 *= fadeShapeGain(timelineT / clip.fadeIn.duration, clip.fadeIn.shape);
  }
  const outStart = len - clip.fadeOut.duration;
  if (clip.fadeOut.duration > 0 && timelineT >= outStart) {
    g2 *= fadeShapeGain((len - timelineT) / clip.fadeOut.duration, clip.fadeOut.shape);
  }
  return g2;
}
function mapTimelineToSource(clip, timelineT) {
  const len = clipRegionLength(clip);
  if (timelineT < 0) return null;
  if (!clip.loop.enabled) {
    if (timelineT >= len) return { offset: clip.sourceEnd, ended: true };
    return { offset: clip.sourceStart + timelineT, ended: false };
  }
  const loopOffset = clip.loop.start - clip.sourceStart;
  const loopLen = clip.sourceEnd - clip.loop.start;
  if (timelineT < loopOffset) {
    return { offset: clip.sourceStart + timelineT, ended: false };
  }
  const intoLoop = timelineT - loopOffset;
  const iteration = Math.floor(intoLoop / loopLen);
  if (clip.loop.count !== Number.POSITIVE_INFINITY && iteration + 1 > clip.loop.count) {
    return { offset: clip.sourceEnd, ended: true };
  }
  const within = intoLoop - iteration * loopLen;
  return { offset: clip.loop.start + within, ended: false };
}
function clipTimelineLifespan(clip) {
  const len = clipRegionLength(clip);
  if (!clip.loop.enabled) return len;
  if (clip.loop.count === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  const loopOffset = clip.loop.start - clip.sourceStart;
  const loopLen = clip.sourceEnd - clip.loop.start;
  return loopOffset + loopLen * clip.loop.count;
}
function sourceDurationChanged(clip, currentDuration) {
  return Math.abs(currentDuration - clip.sourceDuration) > DURATION_EPS;
}
var MIN_CLIP_LENGTH, DURATION_EPS, ClipValidationError, isNum, ClipHistory;
var init_clipEdit = __esm({
  "src/lib/clipEdit.ts"() {
    "use strict";
    MIN_CLIP_LENGTH = 5e-3;
    DURATION_EPS = 8e-3;
    ClipValidationError = class extends Error {
      /** 所有被拒绝的原因（一次提交可能同时违反多条规则） */
      reasons;
      constructor(reasons) {
        super(reasons.join("\uFF1B"));
        this.name = "ClipValidationError";
        this.reasons = reasons;
      }
    };
    isNum = (v) => typeof v === "number" && Number.isFinite(v);
    ClipHistory = class {
      past = [];
      present;
      future = [];
      constructor(initial, label = "\u521D\u59CB") {
        this.present = { clips: initial, label };
      }
      get current() {
        return this.present.clips;
      }
      get canUndo() {
        return this.past.length > 0;
      }
      get canRedo() {
        return this.future.length > 0;
      }
      get lastLabel() {
        return this.present.label;
      }
      /** 提交一次已通过校验的编辑 */
      commit(next, label) {
        this.past.push(this.present);
        this.present = { clips: next, label };
        this.future = [];
        return this.present.clips;
      }
      undo() {
        const prev = this.past.pop();
        if (!prev) return null;
        this.future.push(this.present);
        this.present = prev;
        return { clips: this.present.clips, label: this.present.label };
      }
      redo() {
        const next = this.future.pop();
        if (!next) return null;
        this.past.push(this.present);
        this.present = next;
        return { clips: this.present.clips, label: this.present.label };
      }
    };
  }
});

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

// src/lib/audioEngine.ts
var audioEngine_exports = {};
__export(audioEngine_exports, {
  AudioEngine: () => AudioEngine,
  ClipPlayError: () => ClipPlayError,
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
var ClipPlayError, DecodeError, AudioEngine;
var init_audioEngine = __esm({
  "src/lib/audioEngine.ts"() {
    "use strict";
    init_spatial();
    init_samples();
    init_clipEdit();
    ClipPlayError = class extends Error {
      clipId;
      reason;
      constructor(clipId, reason, message) {
        super(message);
        this.name = "ClipPlayError";
        this.clipId = clipId;
        this.reason = reason;
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
      clipVoices = /* @__PURE__ */ new Map();
      buffers = /* @__PURE__ */ new Map();
      pendingFiles = /* @__PURE__ */ new Map();
      /** 已知缺失/不可读的本地 Blob：播放片段时据此给出独立原因 */
      missingBlobs = /* @__PURE__ */ new Set();
      spatial = null;
      anySolo = false;
      unlockListeners = /* @__PURE__ */ new Set();
      levelListeners = /* @__PURE__ */ new Set();
      endedListeners = /* @__PURE__ */ new Set();
      clipEndedListeners = /* @__PURE__ */ new Set();
      clipEditAppliedListeners = /* @__PURE__ */ new Set();
      boundaryTimer = null;
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
      onClipEnded(fn) {
        this.clipEndedListeners.add(fn);
        return () => {
          this.clipEndedListeners.delete(fn);
        };
      }
      onClipEditApplied(fn) {
        this.clipEditAppliedListeners.add(fn);
        return () => {
          this.clipEditAppliedListeners.delete(fn);
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
          this.rafHandle = requestAnimationFrame(tick);
        };
        this.rafHandle = requestAnimationFrame(tick);
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
        for (const cv of this.clipVoices.values()) {
          cv.panner.distanceModel = s.distanceModel;
          cv.panner.refDistance = s.refDistance;
          cv.panner.rolloffFactor = s.rolloffFactor;
          cv.panner.maxDistance = s.maxDistance;
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
        let buffer;
        try {
          buffer = await this.ensureTrackBuffer(track);
        } catch (err) {
          if (err instanceof ClipPlayError && err.reason === "source-missing-blob") return;
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
      async ensureTrackBuffer(track) {
        const cached = this.buffers.get(track.id);
        if (cached) return cached;
        if (!this.ctx) throw new Error("\u97F3\u9891\u5C1A\u672A\u89E3\u9501");
        let buffer;
        if (track.sourceType === "file") {
          const blob = this.pendingFiles.get(track.id);
          if (!blob) {
            if (this.missingBlobs.has(track.id)) {
              throw new ClipPlayError(
                "__track__",
                "source-missing-blob",
                "\u672C\u5730\u97F3\u9891 Blob \u7F3A\u5931"
              );
            }
            throw new ClipPlayError("__track__", "source-missing-blob", "\u672C\u5730\u97F3\u9891\u5C1A\u672A\u5C31\u7EEA");
          }
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
        return buffer;
      }
      /** 文件 Blob 在解锁后由 UI 层提供（来自 IndexedDB，全程本地） */
      setFileBlob(trackId, blob) {
        this.missingBlobs.delete(trackId);
        this.pendingFiles.set(trackId, blob);
      }
      /** 显式标记本地 Blob 缺失（IndexedDB 查无此键），片段播放时给独立原因 */
      markBlobMissing(trackId) {
        this.pendingFiles.delete(trackId);
        this.missingBlobs.add(trackId);
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
        trackGain.connect(panner);
        const audible = this.shouldBeAudible(track);
        panner.connect(audible ? this.soloBus : this.muteBus);
        const voice = {
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
          duration: buffer.duration
        };
        source.onended = () => {
          if (!voice.playing) return;
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
          if (v) {
            const audible = this.shouldBeAudible(tr);
            if (audible !== v.audiblyRouted) {
              v.panner.disconnect();
              v.panner.connect(audible ? this.soloBus : this.muteBus);
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
      syncTracks(tracks) {
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
      updateClipLive(cv, track) {
        const ctx = this.ctx;
        const t = ctx.currentTime;
        const tau = Math.max(5e-3, this.spatial?.positionTimeConstant ?? 0.05);
        cv.panner.positionX.setTargetAtTime(track.position.x, t, tau);
        cv.panner.positionY.setTargetAtTime(track.position.y, t, tau);
        cv.panner.positionZ.setTargetAtTime(track.position.z, t, tau);
        cv.panner.distanceModel = this.spatial?.distanceModel ?? cv.panner.distanceModel;
        cv.channel = track.channel;
        cv.trackGain.gain.setTargetAtTime(track.muted ? 0 : track.gain, t, 0.01);
        const audible = this.shouldBeAudible(track);
        if (audible !== cv.audiblyRouted) {
          cv.panner.disconnect();
          cv.panner.connect(audible ? this.soloBus : this.muteBus);
          cv.audiblyRouted = audible;
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
        const voice = this.voices.get(track.id);
        if (!voice || !voice.playing) return;
        voice.offset = this.currentOffset(voice);
        this.replaceVoice(voice, track, this.buffers.get(track.id), voice.offset);
      }
      stopTrack(track) {
        const voice = this.voices.get(track.id);
        if (!voice) return;
        if (voice.playing || voice.consumed) {
          this.replaceVoice(voice, track, this.buffers.get(track.id), 0);
        } else {
          voice.offset = 0;
        }
      }
      /** 跳转：offsetSec 秒处；autoplay=true 时立即继续播放 */
      async seekTrack(track, offsetSec, autoplay) {
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
      // ---------- 非破坏性片段播放 ----------
      /**
       * 解析片段引用声轨的源缓冲，并做全部“不能静音假成功”的前置检查：
       * 声轨缺失 / Blob 缺失 / 解码失败 / 时长变化后越界，均抛明确错误。
       */
      async resolveClip(clip, track) {
        if (!track) {
          throw new ClipPlayError(clip.id, "missing-source", `\u7247\u6BB5\u5F15\u7528\u7684\u58F0\u8F68\u5DF2\u4E0D\u5B58\u5728\uFF1A${clip.trackId}`);
        }
        let buffer;
        try {
          buffer = await this.ensureTrackBuffer(track);
        } catch (err) {
          if (err instanceof DecodeError) {
            throw new ClipPlayError(clip.id, "source-decode-error", err.message);
          }
          if (err instanceof ClipPlayError) {
            throw new ClipPlayError(clip.id, err.reason, err.message);
          }
          throw err;
        }
        if (sourceDurationChanged(clip, buffer.duration) && clip.sourceEnd > buffer.duration + 1e-6) {
          throw new ClipPlayError(
            clip.id,
            "out-of-range",
            `\u539F\u6587\u4EF6\u65F6\u957F\u5DF2\u7531 ${clip.sourceDuration.toFixed(3)}s \u53D8\u4E3A ${buffer.duration.toFixed(3)}s\uFF0C\u7247\u6BB5\u51FA\u70B9\u8D8A\u754C\uFF0C\u62D2\u7EDD\u64AD\u653E`
          );
        }
        if (clip.sourceStart < -1e-9 || clip.sourceEnd > buffer.duration + 1e-6) {
          throw new ClipPlayError(
            clip.id,
            "out-of-range",
            `\u7247\u6BB5\u8303\u56F4 ${clip.sourceStart.toFixed(3)}\u2013${clip.sourceEnd.toFixed(3)}s \u8D85\u51FA\u6E90\u65F6\u957F ${buffer.duration.toFixed(3)}s`
          );
        }
        return { track, buffer };
      }
      createClipVoice(clip, track, buffer, shared) {
        const ctx = this.ctx;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const clipFade = ctx.createGain();
        clipFade.gain.value = 0;
        if (buffer.numberOfChannels <= 1) {
          source.connect(clipFade);
        } else {
          const splitter = ctx.createChannelSplitter(buffer.numberOfChannels);
          source.connect(splitter);
          const ch = Math.min(track.channel, buffer.numberOfChannels - 1);
          splitter.connect(clipFade, ch);
        }
        let trackGain;
        let panner;
        if (shared) {
          trackGain = shared.trackGain;
          panner = shared.panner;
        } else {
          trackGain = ctx.createGain();
          trackGain.gain.value = track.muted ? 0 : track.gain;
          panner = new PannerNode(ctx, {
            panningModel: "HRTF",
            distanceModel: this.spatial?.distanceModel ?? "inverse",
            refDistance: this.spatial?.refDistance ?? 1,
            rolloffFactor: this.spatial?.rolloffFactor ?? 1,
            maxDistance: this.spatial?.maxDistance ?? 100,
            positionX: track.position.x,
            positionY: track.position.y,
            positionZ: track.position.z
          });
          const audible = this.shouldBeAudible(track);
          panner.connect(audible ? this.soloBus : this.muteBus);
        }
        clipFade.connect(trackGain);
        if (!shared) trackGain.connect(panner);
        const cv = {
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
          retiring: false
        };
        source.onended = () => {
          if (cv.retiring) return;
          if (cv.successor) return;
          cv.playing = false;
          const stopped = this.createClipVoice(cv.spec, this.latestTrackFor(cv), buffer, void 0);
          this.clipVoices.set(clip.id, stopped);
          this.clipEndedListeners.forEach((fn) => fn(clip.id));
        };
        return cv;
      }
      latestTrackFor(cv) {
        const v = this.voices.get(cv.spec.trackId);
        return v ? v.spec : {
          id: cv.spec.trackId,
          gain: 1,
          muted: false,
          solo: false,
          channel: cv.channel,
          position: { x: 0, y: 0, z: 0 }
        };
      }
      /**
       * 在调度时刻 when（AudioContext 共用时钟）从片段时间线 T0 开始发声一段。
       * 不使用原生 loop：循环回绕 = 在边界处换一段从 loop.start 开始的新 source，
       * 这样当 loop.start > sourceStart 时绝不会错误播到入点之前的素材。
       * 每段都显式 start(when, 源偏移, 段长)，并在有后继边界时只预先武装“下一段”
       * （不递归整链）；下一段提升后再武装它的后继，避免无限循环时无限预建。
       */
      armClipVoice(cv, when, t0) {
        const clip = cv.spec;
        const seg = this.segmentAt(clip, t0);
        if (!seg) {
          throw new ClipPlayError(clip.id, "out-of-range", "\u8D77\u59CB\u4F4D\u7F6E\u5DF2\u8D85\u51FA\u7247\u6BB5\u5BFF\u547D");
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
      armLoopContinuation(cv) {
        if (cv.terminal || cv.successor || cv.pending) return;
        if (cv.timelineEnd < clipTimelineLifespan(cv.spec) - 1e-9) {
          this.armSuccessor(
            cv,
            cv.spec,
            cv.timelineEnd,
            cv.timelineEnd,
            /* muteOldAtBoundary */
            false
          );
        }
      }
      /** 计算时间线 t0 所在播放段：源偏移、段长、边界时间线位置与是否末段 */
      segmentAt(clip, t0) {
        const life = clipTimelineLifespan(clip);
        if (t0 < -1e-9 || t0 >= life + 1e-9) return null;
        if (!clip.loop.enabled) {
          return {
            srcOffset: clip.sourceStart + t0,
            duration: life - t0,
            timelineStart: t0,
            timelineEnd: life,
            terminal: true
          };
        }
        const loopOffset = clip.loop.start - clip.sourceStart;
        const loopLen = clip.sourceEnd - clip.loop.start;
        if (t0 < loopOffset) {
          return {
            srcOffset: clip.sourceStart + t0,
            duration: loopOffset - t0,
            timelineStart: t0,
            timelineEnd: loopOffset,
            terminal: false
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
          terminal
        };
      }
      /**
       * 为当前段武装后继段（循环回绕或编辑生效共用同一机制）：
       * 后继在边界时刻启动于时间线 startT0；编辑生效时旧段在边界采样精确静音，
       * 循环回绕则保持 1（无缝）。定时器越过边界后把后继提升为当前声。
       */
      armSuccessor(cv, nextClip, boundaryT, startT0, muteOldAtBoundary) {
        const buffer = this.buffers.get(nextClip.trackId);
        if (!buffer) return;
        const track = this.latestTrackFor(cv);
        const boundaryCtx = cv.startedAt + (boundaryT - cv.timelineOffset);
        const successor = this.createClipVoice(nextClip, track, buffer, {
          trackGain: cv.trackGain,
          panner: cv.panner
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
      scheduleSegmentEnvelope(cv, when, t0, t1, terminal) {
        const clip = cv.spec;
        const param = cv.clipFade.gain;
        const life = clipTimelineLifespan(clip);
        const CURVE_N = 96;
        param.value = clipFadeGain(clip, t0);
        const fin = clip.fadeIn.duration;
        if (fin > 0 && t0 < fin) {
          const end = Math.min(fin, t1);
          const dur = end - t0;
          const arr = new Float32Array(CURVE_N);
          for (let i = 0; i < CURVE_N; i++) {
            const t = t0 + dur * i / (CURVE_N - 1);
            arr[i] = fadeShapeGain(t / fin, clip.fadeIn.shape);
          }
          param.setValueCurveAtTime(arr, when, Math.max(1e-3, dur));
        }
        const fout = clip.fadeOut.duration;
        if (terminal && fout > 0) {
          const outStart = life - fout;
          if (t1 > outStart) {
            const start = Math.max(outStart, t0);
            const dur = t1 - start;
            const arr = new Float32Array(CURVE_N);
            for (let i = 0; i < CURVE_N; i++) {
              const t = start + dur * i / (CURVE_N - 1);
              arr[i] = fadeShapeGain((life - t) / fout, clip.fadeOut.shape);
            }
            param.setValueCurveAtTime(arr, when + (start - t0), Math.max(1e-3, dur));
          }
        }
      }
      /** 播放单个片段（时间线起点，或给定位置） */
      async playClip(clip, track, timelineT = 0) {
        if (!this.ctx || this.unlock !== "unlocked") {
          throw new ClipPlayError(clip.id, "missing-source", "\u97F3\u9891\u5C1A\u672A\u89E3\u9501");
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
            loop: clip.loop
          },
          buffer.duration
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
      async playClips(items) {
        const results = [];
        if (!this.ctx || this.unlock !== "unlocked") {
          return items.map(({ clip }) => ({
            clipId: clip.id,
            error: new ClipPlayError(clip.id, "missing-source", "\u97F3\u9891\u5C1A\u672A\u89E3\u9501")
          }));
        }
        const ready = [];
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
                loop: clip.loop
              },
              r.buffer.duration
            );
            ready.push({ clip, track: r.track, buffer: r.buffer });
          } catch (err) {
            const e = err instanceof ClipPlayError ? err : err instanceof ClipValidationError ? new ClipPlayError(clip.id, "out-of-range", err.message) : new ClipPlayError(clip.id, "source-decode-error", String(err));
            results.push({ clipId: clip.id, error: e });
          }
        }
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
              error: new ClipPlayError(clip.id, "out-of-range", String(err))
            });
          }
        }
        return results;
      }
      /** 片段当前时间线位置（秒） */
      getClipProgress(clipId) {
        const v = this.clipVoices.get(clipId);
        if (!v) return 0;
        if (!v.playing) return v.timelineOffset;
        const t = v.timelineOffset + (this.ctx.currentTime - v.startedAt);
        const life = clipTimelineLifespan(v.spec);
        return isFinite(life) ? Math.min(t, life) : t;
      }
      isClipPlaying(clipId) {
        return this.clipVoices.get(clipId)?.playing ?? false;
      }
      /** 是否有已提交、等待安全边界生效的编辑 */
      isClipEditPending(clipId) {
        let v = this.clipVoices.get(clipId);
        while (v) {
          if (v.pending) return true;
          v = v.successor;
        }
        return false;
      }
      pauseClip(clipId) {
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
      stopClip(clipId) {
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
      async seekClip(clip, track, timelineT, autoplay) {
        const v = this.clipVoices.get(clip.id);
        if (v) this.teardownClipChain(v, true);
        if (!autoplay) {
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
      stageClipEdit(clip, track) {
        const buffer = this.buffers.get(clip.trackId);
        if (buffer) {
          validateClipFields(
            {
              sourceStart: clip.sourceStart,
              sourceEnd: clip.sourceEnd,
              fadeIn: clip.fadeIn,
              fadeOut: clip.fadeOut,
              loop: clip.loop
            },
            buffer.duration
          );
        }
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
          throw new ClipPlayError(clip.id, "missing-source", "\u6E90\u5C1A\u672A\u5C31\u7EEA\uFF0C\u65E0\u6CD5\u5728\u64AD\u653E\u4E2D\u5E94\u7528\u7F16\u8F91");
        }
        const boundaryT = head.timelineEnd;
        const ctx = this.ctx;
        if (!ctx) throw new ClipPlayError(clip.id, "missing-source", "\u97F3\u9891\u5C1A\u672A\u89E3\u9501");
        this.cancelArmedSuccessor(head);
        head.pending = clip;
        if (ctx.currentTime + 1e-3 < head.startedAt + (boundaryT - head.timelineOffset)) {
          this.armSuccessor(
            head,
            clip,
            boundaryT,
            0,
            /* muteOldAtBoundary */
            true
          );
        } else {
          const boundaryCtx = head.startedAt + (boundaryT - head.timelineOffset);
          const successor = this.createClipVoice(clip, track, buffer, {
            trackGain: head.trackGain,
            panner: head.panner
          });
          head.successor = successor;
          successor.audiblyRouted = head.audiblyRouted;
          this.armClipVoice(successor, Math.max(boundaryCtx, ctx.currentTime), 0);
        }
        return { deferred: true, boundaryTimeline: boundaryT };
      }
      /** 取消已武装但尚未启动的后继（编辑改主意或撤销时），前驱增益回到当前应得值 */
      cancelArmedSuccessor(host) {
        const armed = host.successor;
        if (!armed) return;
        this.disposeVoice(armed, { keepSharedChain: true });
        host.successor = null;
        host.pending = null;
        const now = this.ctx.currentTime;
        host.clipFade.gain.cancelScheduledValues(now);
        host.clipFade.gain.setValueAtTime(clipFadeGain(host.spec, host.timelineOffset + (now - host.startedAt)), now);
      }
      /** 定时器：在边界过后把后继段提升为当前声（循环回绕或编辑生效同一路径） */
      ensureBoundaryTimer() {
        if (this.boundaryTimer != null || !this.ctx) return;
        this.boundaryTimer = setInterval(() => {
          this.processBoundaries();
        }, 25);
      }
      processBoundaries() {
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        for (const [clipId, head] of [...this.clipVoices]) {
          if (!head.successor) continue;
          if (now + 1e-3 < head.successor.startedAt) continue;
          const old = head;
          const promoted = head.successor;
          const wasEdit = old.pending != null;
          old.successor = null;
          old.pending = null;
          old.retiring = true;
          this.disposeVoice(old, { keepSharedChain: true });
          promoted.pending = null;
          this.clipVoices.set(clipId, promoted);
          if (wasEdit) {
            this.clipEditAppliedListeners.forEach((fn) => fn(clipId, promoted.startedAt));
          }
          this.armLoopContinuation(promoted);
        }
      }
      disposeVoice(v, opts) {
        try {
          v.source.onended = null;
          v.source.stop();
        } catch {
        }
        try {
          v.source.disconnect();
        } catch {
        }
        try {
          v.clipFade.disconnect();
        } catch {
        }
        if (!opts?.keepSharedChain) {
          try {
            v.trackGain.disconnect();
          } catch {
          }
          try {
            v.panner.disconnect();
          } catch {
          }
        }
        if (v.successor) this.disposeVoice(v.successor, opts);
      }
      /** 拆除片段整条（可能含已武装后继）播放链 */
      teardownClipChain(head, disconnectShared) {
        try {
          head.source.onended = null;
          head.source.stop();
        } catch {
        }
        this.disposeVoice(head, { keepSharedChain: !disconnectShared });
      }
      removeClip(clipId) {
        const v = this.clipVoices.get(clipId);
        if (v) {
          this.teardownClipChain(v, true);
          this.clipVoices.delete(clipId);
        }
      }
      removeTrack(trackId) {
        const voice = this.voices.get(trackId);
        if (voice) {
          try {
            voice.source.onended = null;
            voice.source.stop();
          } catch {
          }
          voice.source.disconnect();
          voice.trackGain.disconnect();
          voice.panner.disconnect();
        }
        this.voices.delete(trackId);
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
      getProgress(trackId) {
        const v = this.voices.get(trackId);
        if (!v) return null;
        return v.playing ? this.currentOffset(v) : v.offset;
      }
      getDuration(trackId) {
        return this.buffers.get(trackId)?.duration ?? null;
      }
      isPlaying(trackId) {
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
        this.unlock = "locked";
      }
    };
  }
});

// test/engine.test.ts
init_clipEdit();
init_audioEngine();
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
var FakeAudioParam = class {
  value;
  events = [];
  curves = [];
  ramps = [];
  constructor(v) {
    this.value = v;
  }
  setTargetAtTime(v, time, tc) {
    this.value = v;
    this.events.push({ time, value: v, tc });
  }
  setValueAtTime(v, time) {
    this.value = v;
    this.events.push({ time, value: v, tc: 0 });
  }
  setValueCurveAtTime(values, time, duration) {
    this.curves.push({ values, time, duration });
    return this;
  }
  linearRampToValueAtTime(value, time) {
    this.ramps.push({ value, time });
    return this;
  }
  cancelScheduledValues(_time) {
    this.curves = [];
    this.ramps = [];
    return this;
  }
  cancelAndHoldAtTime(time) {
    return this.cancelScheduledValues(time);
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
  loopStart = 0;
  loopEnd = 0;
  started = [];
  stopped = [];
  onended = null;
  start(time, offset = 0, duration) {
    this.started.push({ time, offset, duration });
  }
  stop(time) {
    this.stopped.push({ time });
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
var { AudioEngine: AudioEngine2, DecodeError: DecodeError2 } = await Promise.resolve().then(() => (init_audioEngine(), audioEngine_exports));
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
    assert.ok(v.trackGain.connects.some((c) => c.node === v.panner));
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
    const stopsBefore = 0;
    for (let i = 0; i < 10; i++) {
      engine.syncTracks([
        { ...t, position: { x: 2 + i * 0.1, y: 0.5, z: -i * 0.2 } }
      ]);
    }
    assert.ok(Math.abs(v.panner.positionX.value - 2.9) < 1e-9);
    assert.ok(Math.abs(v.panner.positionY.value - 0.5) < 1e-9);
    assert.ok(Math.abs(v.panner.positionZ.value - -1.8) < 1e-9);
    assert.equal(v.source.started.length, startsBefore);
    assert.equal(v.source.stopped.length, stopsBefore);
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
    id: "c1",
    trackId: "t1",
    name: "clip",
    color: "#fff",
    sourceStart: 0,
    sourceEnd: 1,
    fadeIn: { duration: 0, shape: "linear" },
    fadeOut: { duration: 0, shape: "linear" },
    loop: { enabled: false, start: 0, count: Number.POSITIVE_INFINITY },
    revision: 1,
    sourceDuration: 1,
    createdAt: 0,
    ...over
  };
}
var fieldsOf = (c) => ({
  sourceStart: c.sourceStart,
  sourceEnd: c.sourceEnd,
  fadeIn: c.fadeIn,
  fadeOut: c.fadeOut,
  loop: c.loop
});
describe("\u7247\u6BB5\u7EAF\u903B\u8F91\uFF1A\u6821\u9A8C/\u6DE1\u5316/\u65F6\u95F4\u7EBF/\u64A4\u9500", () => {
  it("\u5165\u70B9/\u51FA\u70B9\u8D8A\u754C\u88AB\u62D2\u7EDD\uFF1B\u6DE1\u5316\u91CD\u53E0\uFF08\u4E0D\u53EF\u89E3\u91CA\u4EA4\u53C9\u6DE1\u5316\uFF09\u88AB\u62D2\u7EDD", () => {
    assert.throws(
      () => validateClipFields(fieldsOf(makeClip({ sourceStart: -0.01, sourceEnd: 1 })), 1),
      ClipValidationError
    );
    assert.throws(
      () => validateClipFields(fieldsOf(makeClip({ sourceStart: 0, sourceEnd: 1.0001 })), 1),
      ClipValidationError
    );
    assert.throws(
      () => validateClipFields(
        fieldsOf(
          makeClip({
            fadeIn: { duration: 0.6, shape: "linear" },
            fadeOut: { duration: 0.6, shape: "linear" }
          })
        ),
        1
      ),
      /重叠/
    );
    assert.throws(
      () => validateClipFields(
        fieldsOf(makeClip({ loop: { enabled: true, start: 1, count: Number.POSITIVE_INFINITY } })),
        1
      ),
      /循环回跳点/
    );
    assert.throws(
      () => validateClipFields(
        fieldsOf(
          makeClip({
            fadeOut: { duration: 0.1, shape: "linear" },
            loop: { enabled: true, start: 0.2, count: Number.POSITIVE_INFINITY }
          })
        ),
        1
      ),
      /持续循环/
    );
  });
  it("\u6DE1\u5316\u66F2\u7EBF\u5728\u7AEF\u70B9\u4E3A 0/1\uFF0C\u7B49\u529F\u7387\u4E2D\u70B9\u2248-3dB", () => {
    const c = makeClip({
      sourceEnd: 1,
      fadeIn: { duration: 0.4, shape: "equalPower" },
      fadeOut: { duration: 0.4, shape: "linear" }
    });
    assert.ok(Math.abs(clipFadeGain(c, 0)) < 1e-9);
    assert.ok(Math.abs(clipFadeGain(c, 0.2) - Math.SQRT1_2) < 1e-6);
    assert.ok(Math.abs(clipFadeGain(c, 0.5) - 1) < 1e-9);
    assert.ok(Math.abs(clipFadeGain(c, 0.8) - 0.5) < 1e-6);
    assert.ok(Math.abs(clipFadeGain(c, 1 - 1e-7)) < 1e-4);
  });
  it("\u65F6\u95F4\u7EBF\u2192\u539F\u59CB\u65F6\u95F4\uFF1A\u65E0\u5FAA\u73AF\u7EBF\u6027\uFF1B\u5FAA\u73AF\u6309\u56DE\u8DF3\u70B9\u4E0E\u6B21\u6570\u73AF\u7ED5\u5E76\u7ED3\u675F", () => {
    const c = makeClip({
      sourceStart: 1,
      sourceEnd: 2,
      loop: { enabled: true, start: 1.5, count: 2 }
    });
    assert.deepEqual(mapTimelineToSource(c, 0), { offset: 1, ended: false });
    assert.deepEqual(mapTimelineToSource(c, 0.4), { offset: 1.4, ended: false });
    assert.deepEqual(mapTimelineToSource(c, 0.5), { offset: 1.5, ended: false });
    assert.deepEqual(mapTimelineToSource(c, 0.99), { offset: 1.99, ended: false });
    assert.ok(Math.abs(clipTimelineLifespan(c) - 1.5) < 1e-9);
    const end = mapTimelineToSource(c, 1.5);
    assert.equal(end.ended, true);
  });
  it("\u64A4\u9500/\u6062\u590D\u53EA\u6362\u7F16\u8F91\u63CF\u8FF0\u4E14\u6570\u503C\u7CBE\u786E\u3001\u91CD\u590D\u64CD\u4F5C\u4E0D\u7D2F\u79EF\u8BEF\u5DEE", () => {
    const initial = makeClip();
    const h = new ClipHistory([initial]);
    const edited = makeClip({
      revision: 2,
      sourceStart: 0.123456789,
      sourceEnd: 0.987654321,
      fadeIn: { duration: 0.23456789, shape: "exponential" }
    });
    h.commit([edited], "edit");
    assert.equal(h.current[0].sourceStart, 0.123456789);
    const u1 = h.undo();
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
    assert.equal(h.current[0].fadeIn.shape, "exponential");
    assert.equal(h.current[0].revision, 2);
  });
});
describe("AudioEngine \u7247\u6BB5\u64AD\u653E\uFF08\u6A21\u62DF\u73AF\u5883\uFF09", () => {
  let eng;
  const track = baseTrack({ id: "t1", duration: 1 });
  beforeEach(async () => {
    eng = new AudioEngine2();
    await eng.resume();
    await eng.ensureTrack(track);
  });
  afterEach(() => eng.dispose());
  const voicesMap = () => eng.clipVoices;
  it("\u64AD\u653E\u7247\u6BB5\uFF1A\u6E90\u504F\u79FB\u4ECE\u5165\u70B9\u5F00\u59CB\u3001\u5BFF\u547D\u9650\u5B9A\u4E3A\u51FA\u70B9\u957F\u5EA6\uFF0C\u5E76\u5E26\u6DE1\u5316\u5305\u7EDC", async () => {
    const clip = makeClip({
      sourceStart: 0.2,
      sourceEnd: 0.8,
      fadeIn: { duration: 0.1, shape: "linear" },
      fadeOut: { duration: 0.1, shape: "linear" }
    });
    await eng.playClip(clip, track);
    const v = voicesMap().get("c1");
    const last = v.source.started[v.source.started.length - 1];
    assert.ok(Math.abs(last.offset - 0.2) < 1e-9);
    assert.ok(Math.abs((last.duration ?? 0) - 0.6) < 1e-9);
    assert.ok(Math.abs(v.clipFade.gain.value) < 1e-9);
    assert.ok(v.clipFade.gain.curves.length >= 1);
  });
  it("\u4E24\u6761\u7247\u6BB5\u7ECF playClips \u5728\u540C\u4E00 ctx \u65F6\u523B\u542F\u52A8\uFF08\u5171\u7528\u540C\u4E00\u65F6\u949F\uFF09\uFF0C\u5404\u81EA\u65B9\u4F4D\u53D6\u58F0\u8F68 panner", async () => {
    const clipA = makeClip({ id: "a", trackId: "t1", sourceStart: 0, sourceEnd: 0.5 });
    const otherTrack = baseTrack({ id: "t2", position: { x: -3, y: 0, z: 0 } });
    await eng.ensureTrack(otherTrack);
    const clipB = makeClip({ id: "b", trackId: "t2", sourceStart: 0.1, sourceEnd: 0.6 });
    const ctx = eng.ctx;
    const results = await eng.playClips([
      { clip: clipA, track },
      { clip: clipB, track: otherTrack }
    ]);
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => !r.error));
    const vm = voicesMap();
    const ta = vm.get("a").source.started.at(-1).time;
    const tb = vm.get("b").source.started.at(-1).time;
    assert.equal(ta, tb);
    assert.ok(ta > ctx.currentTime || ta === ctx.currentTime + 0.03 || Math.abs(ta - (ctx.currentTime + 0.03)) < 1e-6);
    const pa = vm.get("a").panner;
    const pb = vm.get("b").panner;
    assert.ok(Math.abs(pa.positionX.value - 2) < 1e-9);
    assert.ok(Math.abs(pb.positionX.value - -3) < 1e-9);
  });
  it("\u8D8A\u754C\u3001\u6E90\u7F3A\u5931\u3001\u89E3\u7801\u5931\u8D25\u4EA7\u751F\u72EC\u7ACB\u9519\u8BEF\u800C\u975E\u9759\u97F3", async () => {
    const badRange = makeClip({ id: "oob", sourceEnd: 5, sourceDuration: 1 });
    const res = await eng.playClips([{ clip: badRange, track }]);
    assert.equal(res[0].error?.reason, "out-of-range");
    const missing = makeClip({ id: "miss", trackId: "ghost" });
    await assert.rejects(
      eng.playClip(missing, void 0),
      (e) => e instanceof ClipPlayError && e.reason === "missing-source"
    );
    const bad = baseTrack({ id: "badfile", sourceType: "file" });
    eng.setFileBlob("badfile", new Blob([new TextEncoder().encode("BAD")], { type: "audio/x" }));
    const clipDec = makeClip({ id: "dec", trackId: "badfile" });
    await assert.rejects(
      eng.playClip(clipDec, bad),
      (e) => e instanceof ClipPlayError && e.reason === "source-decode-error"
    );
  });
  it("\u64AD\u653E\u4E2D\u63D0\u4EA4\u7F16\u8F91\uFF1A\u8FD4\u56DE deferred \u4E14\u4E0D\u7ACB\u5373\u6362\u6E90\uFF1B\u8D8A\u8FC7\u5B89\u5168\u8FB9\u754C\u540E\u5355\u4E00\u540E\u7EE7\u53D1\u58F0\uFF0C\u65E0\u53CC\u91CD\u64AD\u653E", async () => {
    const clip = makeClip({
      sourceStart: 0,
      sourceEnd: 0.3,
      loop: { enabled: true, start: 0, count: Number.POSITIVE_INFINITY }
    });
    await eng.playClip(clip, track);
    const vm = voicesMap();
    const v1 = vm.get("c1");
    const startedCountBefore = v1.source.started.length;
    const edited = makeClip({
      revision: 2,
      sourceStart: 0,
      sourceEnd: 0.2,
      loop: { enabled: true, start: 0, count: Number.POSITIVE_INFINITY }
    });
    const r = eng.stageClipEdit(edited, track);
    assert.equal(r.deferred, true);
    assert.equal(v1.source.started.length, startedCountBefore);
    const armed = v1.successor;
    assert.ok(armed != null);
    const succStart = armed.source.started.at(-1).time;
    eng.ctx.currentTime = succStart + 0.01;
    await new Promise((res) => setTimeout(res, 60));
    const head = voicesMap().get("c1");
    assert.equal(head, armed);
    assert.ok(v1.source.stopped.length >= 1);
    assert.equal(head.playing, true);
  });
  it("\u64AD\u653E\u4E2D\u63D0\u4EA4\u975E\u6CD5\u7F16\u8F91\u88AB\u62D2\u7EDD\uFF0C\u5F53\u524D\u58F0\u4E0D\u53D7\u5F71\u54CD", async () => {
    const clip = makeClip({ sourceStart: 0, sourceEnd: 0.4 });
    await eng.playClip(clip, track);
    const v1 = voicesMap().get("c1");
    const illegal = makeClip({ revision: 2, sourceEnd: 9 });
    assert.throws(() => eng.stageClipEdit(illegal, track), ClipValidationError);
    assert.equal(v1.successor, null);
  });
  it("\u672A\u64AD\u653E\u65F6\u63D0\u4EA4\u7F16\u8F91\u7ACB\u5373\u6362\u63CF\u8FF0\uFF0C\u4E0B\u6B21\u64AD\u653E\u91C7\u7528\u65B0\u8FB9\u754C\uFF1B\u6682\u505C/\u505C\u6B62\u4E0D\u6B8B\u7559\u53CC\u91CD\u58F0", async () => {
    const clip = makeClip({ sourceStart: 0, sourceEnd: 0.5 });
    await eng.playClip(clip, track);
    eng.pauseClip("c1");
    const edited = makeClip({ revision: 2, sourceStart: 0.1, sourceEnd: 0.4 });
    const r = eng.stageClipEdit(edited, track);
    assert.equal(r.deferred, false);
    await eng.playClip(edited, track);
    const v = voicesMap().get("c1");
    assert.ok(Math.abs(v.source.started.at(-1).offset - 0.1) < 1e-9);
    eng.stopClip("c1");
    assert.equal(eng.isClipPlaying("c1"), false);
    assert.equal(voicesMap().get("c1").source.started.length, 0);
  });
  it("\u5FAA\u73AF\u524D\u5BFC(loopStart>\u5165\u70B9)\uFF1A\u6BCF\u6BB5\u7CBE\u786E\u5F15\u7528\u6E90\u533A\u95F4\uFF0C\u56DE\u7ED5\u4E0D\u64AD\u5165\u70B9\u524D\u7D20\u6750", async () => {
    const ctx = eng.ctx;
    const clip = makeClip({
      sourceStart: 0.2,
      sourceEnd: 0.8,
      loop: { enabled: true, start: 0.5, count: Number.POSITIVE_INFINITY }
    });
    await eng.playClip(clip, track);
    const vm = voicesMap();
    let head = vm.get("c1");
    assert.ok(Math.abs(head.source.started[0].offset - 0.2) < 1e-9);
    assert.ok(Math.abs((head.source.started[0].duration ?? 0) - 0.3) < 1e-9);
    let armed = head.successor;
    assert.ok(Math.abs(armed.source.started[0].offset - 0.5) < 1e-9);
    assert.ok(Math.abs((armed.source.started[0].duration ?? 0) - 0.3) < 1e-9);
    ctx.currentTime = armed.source.started[0].time + 0.01;
    await new Promise((res) => setTimeout(res, 60));
    head = vm.get("c1");
    assert.ok(Math.abs(head.source.started[0].offset - 0.5) < 1e-9);
    armed = head.successor;
    assert.ok(Math.abs(armed.source.started[0].offset - 0.5) < 1e-9);
  });
  it("\u6709\u9650\u5FAA\u73AF\u5728\u89C4\u5B9A\u6B21\u6570\u540E\uFF1A\u672B\u6BB5\u4E3A terminal\u3001\u4E0D\u518D\u6B66\u88C5\u540E\u7EE7\uFF1Bonended \u540E\u5F52\u96F6", async () => {
    const ctx = eng.ctx;
    const clip = makeClip({
      sourceStart: 0,
      sourceEnd: 0.2,
      loop: { enabled: true, start: 0, count: 2 }
    });
    await eng.playClip(clip, track);
    const vm = voicesMap();
    const h = vm.get("c1");
    const succ = h.successor;
    assert.ok(succ, "\u7B2C 1 \u6BB5\u5E94\u6B66\u88C5\u540E\u7EE7");
    ctx.currentTime = succ.source.started[0].time + 0.01;
    await new Promise((res) => setTimeout(res, 60));
    const head = vm.get("c1");
    assert.equal(head.terminal, true);
    assert.ok(Math.abs(head.timelineEnd - 0.4) < 1e-9);
    assert.equal(head.successor, null);
    const onended = head.source.onended;
    assert.ok(onended);
    onended();
    assert.equal(eng.isClipPlaying("c1"), false);
  });
});
