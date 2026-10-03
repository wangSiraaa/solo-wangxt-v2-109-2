/**
 * 非破坏性片段编辑的纯逻辑：校验、淡化曲线、时间线→原始时间映射、撤销历史。
 *
 * 这里的一切只处理“编辑描述”（Clip），绝不触碰原始音频数据/Blob。
 * 所有函数无副作用、可在 Node 下直接测试。
 */
import type { Clip, ClipIssueInfo, FadeShape, FadeSpec, Track } from '../types';

/** 允许的最小片段长度（秒），避免退化的零长区间 */
export const MIN_CLIP_LENGTH = 0.005;
/** 时长变化判定容差：小于该差视为解码采样边界误差，不算“原文件时长变化” */
export const DURATION_EPS = 0.008;

export class ClipValidationError extends Error {
  /** 所有被拒绝的原因（一次提交可能同时违反多条规则） */
  reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join('；'));
    this.name = 'ClipValidationError';
    this.reasons = reasons;
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validateFade(f: FadeSpec | undefined, label: string, regionLen: number): string[] {
  const errs: string[] = [];
  if (!f || !isNum(f.duration) || f.duration < 0) {
    errs.push(`${label}长度非法`);
    return errs;
  }
  if (f.duration > regionLen + 1e-9) {
    errs.push(`${label}长度 ${f.duration.toFixed(3)}s 超出片段长度 ${regionLen.toFixed(3)}s`);
  }
  if (f.shape !== 'linear' && f.shape !== 'equalPower' && f.shape !== 'exponential') {
    errs.push(`${label}曲线类型未知`);
  }
  return errs;
}

/**
 * 校验一组片段编辑字段（相对于给定源时长）。
 * 非法范围、淡化越界/重叠（会产生不可解释的交叉淡化）、循环点越界全部拒绝，
 * 返回全部原因；合法时返回归一化后的字段（不四舍五入已提交数值，避免累积误差）。
 */
export function validateClipFields(
  fields: {
    sourceStart: number;
    sourceEnd: number;
    fadeIn: FadeSpec;
    fadeOut: FadeSpec;
    loop: Clip['loop'];
  },
  sourceDuration: number,
): void {
  const reasons: string[] = [];
  const { sourceStart, sourceEnd, fadeIn, fadeOut, loop } = fields;

  if (!isNum(sourceDuration) || sourceDuration <= 0) {
    throw new ClipValidationError(['源时长未知，尚不能定义片段']);
  }
  if (!isNum(sourceStart)) reasons.push('入点不是有效数值');
  if (!isNum(sourceEnd)) reasons.push('出点不是有效数值');
  if (reasons.length > 0) throw new ClipValidationError(reasons);

  if (sourceStart < -1e-9) reasons.push(`入点 ${sourceStart.toFixed(3)}s 越过源起点 0`);
  if (sourceEnd > sourceDuration + 1e-6) {
    reasons.push(`出点 ${sourceEnd.toFixed(3)}s 越过源时长 ${sourceDuration.toFixed(3)}s`);
  }
  if (sourceEnd - sourceStart < MIN_CLIP_LENGTH) {
    reasons.push(
      `片段长度 ${(sourceEnd - sourceStart).toFixed(3)}s 短于最小值 ${MIN_CLIP_LENGTH}s`,
    );
  }
  if (reasons.length > 0) throw new ClipValidationError(reasons);

  const regionLen = sourceEnd - sourceStart;
  reasons.push(...validateFade(fadeIn, '淡入', regionLen));
  reasons.push(...validateFade(fadeOut, '淡出', regionLen));
  if (isNum(fadeIn?.duration) && isNum(fadeOut?.duration)) {
    // 淡化相互重叠会形成无法解释的交叉淡化（没有两条可交叉的素材）→ 拒绝
    if (fadeIn.duration + fadeOut.duration > regionLen + 1e-9) {
      reasons.push(
        `淡入 ${fadeIn.duration.toFixed(3)}s 与淡出 ${fadeOut.duration.toFixed(3)}s 重叠，构成不可解释的交叉淡化`,
      );
    }
  }

  if (!loop || typeof loop.enabled !== 'boolean') {
    reasons.push('循环规则缺失');
  } else if (loop.enabled) {
    if (!isNum(loop.start)) {
      reasons.push('循环点不是有效数值');
    } else if (loop.start < sourceStart - 1e-9 || loop.start >= sourceEnd - 1e-9) {
      reasons.push(
        `循环回跳点 ${loop.start.toFixed(3)}s 必须位于入点 ${sourceStart.toFixed(3)}s 与出点 ${sourceEnd.toFixed(3)}s 之间`,
      );
    } else {
      const introLen = loop.start - sourceStart;
      const loopLen = sourceEnd - loop.start;
      // 淡入必须在首轮进入循环区之前完成，否则回绕会截断淡入（语义不可解释）
      if (fadeIn.duration > introLen + 1e-9) {
        reasons.push(
          `淡入 ${fadeIn.duration.toFixed(3)}s 超过循环前导长度 ${introLen.toFixed(3)}s，回绕会截断淡入`,
        );
      }
      // 每轮淡出必须落在一次循环之内
      if (fadeOut.duration > loopLen + 1e-9) {
        reasons.push(
          `淡出 ${fadeOut.duration.toFixed(3)}s 超过单次循环长度 ${loopLen.toFixed(3)}s`,
        );
      }
    }
    const countOk =
      loop.count === Number.POSITIVE_INFINITY ||
      (Number.isInteger(loop.count) && loop.count >= 1);
    if (!countOk) reasons.push('循环次数必须为 ≥1 的整数或持续循环');
    // 无限循环永远到不了出点，淡出没有可解释的落点
    if (countOk && loop.count === Number.POSITIVE_INFINITY && fadeOut.duration > 0) {
      reasons.push('持续循环没有终点，不能设置淡出（请限定循环次数或取消淡出）');
    }
  }

  if (reasons.length > 0) throw new ClipValidationError(reasons);
}

/** 片段可播放区域长度（秒） */
export function clipRegionLength(clip: Clip): number {
  return Math.max(0, clip.sourceEnd - clip.sourceStart);
}

/** 淡化曲线：返回 0..1；t 为距淡化起点的归一化进度 0..1 */
export function fadeShapeGain(p: number, shape: FadeShape): number {
  const x = Math.min(1, Math.max(0, p));
  switch (shape) {
    case 'linear':
      return x;
    case 'equalPower':
      // 等功率：sin(π/2·p)，用于淡化端点保持等响度
      return Math.sin((Math.PI / 2) * x);
    case 'exponential':
      // 指数：避免在 0 处取 -∞，以 -60dB 为底
      return x <= 0 ? 0 : Math.pow(10, -3 * (1 - x));
    default:
      return x;
  }
}

/**
 * 片段时间线上某时刻的淡化增益（1 = 无衰减）。
 * timelineT 为相对片段开头的秒数，区间 [0, regionLen)。
 */
export function clipFadeGain(clip: Clip, timelineT: number): number {
  const len = clipRegionLength(clip);
  if (timelineT < 0 || timelineT >= len) return 0;
  let g = 1;
  if (clip.fadeIn.duration > 0 && timelineT < clip.fadeIn.duration) {
    g *= fadeShapeGain(timelineT / clip.fadeIn.duration, clip.fadeIn.shape);
  }
  const outStart = len - clip.fadeOut.duration;
  if (clip.fadeOut.duration > 0 && timelineT >= outStart) {
    g *= fadeShapeGain((len - timelineT) / clip.fadeOut.duration, clip.fadeOut.shape);
  }
  return g;
}

/**
 * 片段时间线位置 → 原始音频时间偏移（秒）。
 * - 循环关闭：线性映射，到达出点结束。
 * - 循环开启：先走到 loop.start，再在 [loop.start, sourceEnd) 间按共用时钟回绕；
 *   有限次数播完返回 ended=true。
 * 返回 null 表示该时间线位置已超出片段（不发声）。
 */
export function mapTimelineToSource(
  clip: Clip,
  timelineT: number,
): { offset: number; ended: boolean } | null {
  const len = clipRegionLength(clip);
  if (timelineT < 0) return null;

  if (!clip.loop.enabled) {
    if (timelineT >= len) return { offset: clip.sourceEnd, ended: true };
    return { offset: clip.sourceStart + timelineT, ended: false };
  }

  const loopOffset = clip.loop.start - clip.sourceStart; // 循环回跳点在片段内的位置
  const loopLen = clip.sourceEnd - clip.loop.start; // 每轮循环长度
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

/** 时间线总寿命（秒）：有限循环为首轮 + N 轮循环；无限循环为 Infinity */
export function clipTimelineLifespan(clip: Clip): number {
  const len = clipRegionLength(clip);
  if (!clip.loop.enabled) return len;
  if (clip.loop.count === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  const loopOffset = clip.loop.start - clip.sourceStart;
  const loopLen = clip.sourceEnd - clip.loop.start;
  return loopOffset + loopLen * clip.loop.count;
}

/** 当前源时长相对建片段时是否变化（超过解码边界容差） */
export function sourceDurationChanged(clip: Clip, currentDuration: number): boolean {
  return Math.abs(currentDuration - clip.sourceDuration) > DURATION_EPS;
}

/** 片段范围是否仍完整落在给定源时长内 */
export function clipInRange(clip: Clip, sourceDuration: number): boolean {
  return (
    isNum(sourceDuration) &&
    sourceDuration > 0 &&
    clip.sourceStart >= -1e-9 &&
    clip.sourceEnd <= sourceDuration + 1e-6 &&
    clipRegionLength(clip) >= MIN_CLIP_LENGTH
  );
}

/** 用于创建默认片段的初始字段（整段引用，不预设淡化；循环默认关闭，若启用则持续循环） */
export function defaultClipFields(sourceDuration: number) {
  return {
    sourceStart: 0,
    sourceEnd: sourceDuration,
    fadeIn: { duration: 0, shape: 'linear' as FadeShape },
    fadeOut: { duration: 0, shape: 'linear' as FadeShape },
    loop: { enabled: false, start: 0, count: Number.POSITIVE_INFINITY },
  };
}

/**
 * 依据当前声轨运行态给出片段的独立不可试听原因（不修改编辑历史）。
 * 缺失声轨 / 本地 Blob 丢失 / 解码失败 / 时长变化后越界 分别返回独立原因；
 * 时长变化但仍在范围内只警告（可继续试听），编辑历史绝不抹掉。
 */
export function diagnoseClip(
  clip: Clip,
  track: Track | undefined,
  knownDuration: number | null | undefined,
): ClipIssueInfo | null {
  if (!track) return { issue: 'missing-source', detail: '引用的声轨已删除，编辑仍保留' };
  if (track.sourceType === 'file') {
    if (track.status === 'decode-error') {
      return { issue: 'source-decode-error', detail: track.errorMessage ?? '原始文件解码失败' };
    }
    if (knownDuration == null && track.status !== 'ready') {
      return { issue: 'source-missing-blob', detail: track.errorMessage ?? '本地文件缺失或待解锁' };
    }
  }
  if (knownDuration != null && isFinite(knownDuration) && knownDuration > 0) {
    if (clip.sourceEnd > knownDuration + 1e-6 || clip.sourceStart < -1e-9) {
      return {
        issue: 'out-of-range',
        detail: `片段边界（${clip.sourceStart.toFixed(2)}–${clip.sourceEnd.toFixed(2)}s）超出当前源时长 ${knownDuration.toFixed(2)}s`,
      };
    }
    if (sourceDurationChanged(clip, knownDuration)) {
      return {
        issue: 'source-changed',
        detail: `原文件时长由 ${clip.sourceDuration.toFixed(2)}s 变为 ${knownDuration.toFixed(2)}s（片段仍在范围内，可试听；建议复核边界）`,
      };
    }
  }
  return null;
}

// ---------- 撤销 / 恢复：只存编辑描述，恢复时逐字段精确还原 ----------

interface HistoryEntry {
  clips: Clip[];
  label: string;
}

/**
 * 编辑描述历史。快照为 Clip 描述数组（不含任何音频数据）。
 * undo/redo 直接换入当时的快照引用，旧边界与淡化逐数值精确恢复，
 * 重复撤销/重做不在数值上反复加工，因此不累积误差。
 */
export class ClipHistory {
  private past: HistoryEntry[] = [];
  private present: HistoryEntry;
  private future: HistoryEntry[] = [];

  constructor(initial: Clip[], label = '初始') {
    this.present = { clips: initial, label };
  }

  get current(): Clip[] {
    return this.present.clips;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get lastLabel(): string {
    return this.present.label;
  }

  /** 提交一次已通过校验的编辑 */
  commit(next: Clip[], label: string): Clip[] {
    this.past.push(this.present);
    this.present = { clips: next, label };
    this.future = [];
    return this.present.clips;
  }

  undo(): { clips: Clip[]; label: string } | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(this.present);
    this.present = prev;
    return { clips: this.present.clips, label: this.present.label };
  }

  redo(): { clips: Clip[]; label: string } | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(this.present);
    this.present = next;
    return { clips: this.present.clips, label: this.present.label };
  }
}
