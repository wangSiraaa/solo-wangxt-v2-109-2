/**
 * 非破坏性片段的纯逻辑：校验、时间映射、淡化包络、工程迁移。
 * 引擎与 UI 共用，保证“同一条规则”既用于拖拽提交、也用于播放前自检。
 */
import type {
  Clip,
  ClipDraft,
  ClipFade,
  ClipIssue,
  FadeCurve,
  ProjectDoc,
  Track,
} from '../types';

/** 边界比较容差（秒）：约 2 个 48kHz 音频帧，吸收持久化/浮点往返误差 */
export const CLIP_EPS = 1 / 24000;

/** 提交失败：范围/淡化/循环不合法。非法描述绝不进入状态，更不会被静音播放掩盖 */
export class ClipValidationError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(issues.join('；'));
    this.name = 'ClipValidationError';
    this.issues = issues;
  }
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * 校验片段描述。
 * @param duration 已知的原始文件时长（秒）；为 null 时只校验相对关系，
 *                 无法证明越界的提交仍会被拒绝（UI 在 ready 前不开放编辑）。
 */
export function validateClipDraft(draft: ClipDraft, duration: number | null): string[] {
  const issues: string[] = [];
  const { inPoint, outPoint, fadeIn, fadeOut, loop } = draft;

  if (!isNum(inPoint) || !isNum(outPoint)) {
    issues.push('入点/出点必须是有限数值');
    return issues;
  }
  if (inPoint < -CLIP_EPS) issues.push(`入点 ${fmt(inPoint)}s 越界（不能小于 0）`);
  if (duration != null && outPoint > duration + CLIP_EPS) {
    issues.push(`出点 ${fmt(outPoint)}s 越过原文件时长 ${fmt(duration)}s`);
  }
  if (outPoint <= inPoint + CLIP_EPS) issues.push('出点必须严格晚于入点');

  const clipLen = outPoint - inPoint;

  const checkFade = (f: ClipFade, label: string) => {
    if (!isNum(f.length)) {
      issues.push(`${label}长度必须是有限数值`);
      return;
    }
    if (f.length < -CLIP_EPS) issues.push(`${label}长度 ${fmt(f.length)}s 不能为负（越界）`);
    if (f.curve !== 'linear' && f.curve !== 'equalPower') {
      issues.push(`${label}曲线类型非法`);
    }
  };
  checkFade(fadeIn, '淡入');
  checkFade(fadeOut, '淡出');

  const fi = Math.max(0, fadeIn.length);
  const fo = Math.max(0, fadeOut.length);
  // 淡化重叠会产生无法解释的交叉淡化：拒绝，而不是静默截断
  if (fi + fo > clipLen + CLIP_EPS) {
    issues.push(
      `淡入 ${fmt(fi)}s + 淡出 ${fmt(fo)}s 超过片段长度 ${fmt(clipLen)}s，重叠会产生不可解释的交叉淡化`,
    );
  }

  if (loop.enabled) {
    if (!isNum(loop.inPoint) || !isNum(loop.outPoint)) {
      issues.push('循环入/出点必须是有限数值');
    } else {
      if (loop.inPoint < inPoint - CLIP_EPS) issues.push('循环入点越过片段入点（越界）');
      if (loop.outPoint > outPoint + CLIP_EPS) issues.push('循环出点越过片段出点（越界）');
      if (loop.outPoint <= loop.inPoint + CLIP_EPS) issues.push('循环区间必须为正长度');
      const loopLen = loop.outPoint - loop.inPoint;
      // 每次循环都要完整放下淡入与淡出；首段之外不再播放 inPoint..loop.inPoint 的导言
      if (fi + fo > loopLen + CLIP_EPS) {
        issues.push(
          `循环区间长度 ${fmt(loopLen)}s 容不下淡入+淡出 ${fmt(fi + fo)}s（重叠会产生不可解释的交叉淡化）`,
        );
      }
    }
  }
  return issues;
}

export function assertValidClip(draft: ClipDraft, duration: number | null): void {
  const issues = validateClipDraft(draft, duration);
  if (issues.length) throw new ClipValidationError(issues);
}

/** 片段可播放长度（秒，原始时间轴单位） */
export function clipLength(clip: Clip): number {
  return clip.outPoint - clip.inPoint;
}

/**
 * 片段本地播放位置（0 = 片段入点）映射到原始缓冲偏移。
 * 首遍线性播放完整片段 [inPoint, outPoint)；开启循环时此后在循环体上回绕。
 */
export function localToSourceOffset(clip: Clip, local: number): number {
  const len = clipLength(clip);
  if (!clip.loop.enabled) {
    return clip.inPoint + Math.min(Math.max(0, local), len);
  }
  if (local < len) return clip.inPoint + Math.max(0, local);
  const loopLen = Math.max(CLIP_EPS, clip.loop.outPoint - clip.loop.inPoint);
  const intoLoop = local - len;
  const wrapped = ((intoLoop % loopLen) + loopLen) % loopLen;
  return clip.loop.inPoint + wrapped;
}

/** 淡化曲线在相位 p∈[0,1] 上的增益 0..1 */
export function fadeGain(curve: FadeCurve, p: number): number {
  const x = Math.min(1, Math.max(0, p));
  if (curve === 'equalPower') {
    // 等功率：淡入 cos 法则 0→1，淡出 1→0；端点钳死，避免 6e-17 浮点底噪
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return Math.cos(((1 - x) * Math.PI) / 2);
  }
  return x;
}

/**
 * 已排程片段在给定本地位置处的淡化包络增益（用于播放中修改边界后
 * 在安全边界换流、以及从片段内部恢复播放时的起始增益）。
 */
export function envelopeAt(clip: Clip, local: number, len: number): number {
  let g = 1;
  if (clip.fadeIn.length > 0 && local < clip.fadeIn.length) {
    g = Math.min(g, fadeGain(clip.fadeIn.curve, local / clip.fadeIn.length));
  }
  const tail = len - local;
  if (clip.fadeOut.length > 0 && tail < clip.fadeOut.length) {
    g = Math.min(g, fadeGain(clip.fadeOut.curve, 1 - tail / clip.fadeOut.length));
  }
  return g;
}

export function fmt(t: number): string {
  return (Math.round(t * 1000) / 1000).toString();
}

/**
 * 片段当前的独立问题。问题只影响“能否试听”，绝不抹掉片段编辑历史。
 * 与整轨 decode-error 分开呈现：缺失 / 解码失败 / 时长变化 / 未就绪各有独立原因。
 */
export function getClipIssue(track: Track, clip: Clip, unlocked: boolean): ClipIssue | null {
  const actual = track.duration ?? null;
  if (
    clip.sourceDuration != null &&
    actual != null &&
    Math.abs(actual - clip.sourceDuration) > CLIP_EPS
  ) {
    return {
      kind: 'duration-changed',
      message: `原文件时长已变化：记录 ${clip.sourceDuration.toFixed(3)}s，当前 ${actual.toFixed(
        3,
      )}s。片段定义保留，请重新审阅边界后再试听。`,
    };
  }
  // 先看边界是否已经超出当前可知时长（可能由外部替换文件引起）
  if (actual != null && clip.outPoint > actual + CLIP_EPS) {
    return {
      kind: 'duration-changed',
      message: `片段出点 ${fmt(clip.outPoint)}s 已越过当前原文件时长 ${fmt(
        actual,
      )}s，需重新审阅。`,
    };
  }
  if (track.status === 'decode-error') {
    if (track.errorMessage?.includes('Blob 缺失')) {
      return {
        kind: 'source-missing',
        message: `原始本地文件已从 IndexedDB 丢失（${track.errorMessage}）。片段定义与编辑历史保留，重新导入同名文件后可恢复试听。`,
      };
    }
    return {
      kind: 'decode-error',
      message: `原始文件解码失败：${track.errorMessage ?? '未知原因'}。片段定义与编辑历史保留。`,
    };
  }
  if (!unlocked || track.status === 'pending' || track.status === 'loading' || actual == null) {
    return { kind: 'not-ready', message: '原始音频尚未就绪，解锁并解码后可试听（描述仍可审阅/编辑）。' };
  }
  return null;
}

/** 片段是否可安全试听（无独立问题） */
export function clipPlayable(track: Track, clip: Clip, unlocked: boolean): boolean {
  return getClipIssue(track, clip, unlocked) === null;
}

/**
 * 旧工程迁移：v1（整轨）补空片段表；只补描述字段，绝不触碰 blobs 仓。
 * 不识别的更高版本保持原样抛出，由调用方提示。
 */
export function migrateDoc(raw: ProjectDoc): ProjectDoc {
  if (raw.version === 2) return raw;
  if (raw.version !== 1) {
    throw new Error(`不支持的工程版本：${(raw as { version?: number }).version ?? '未知'}`);
  }
  const tracks: Track[] = raw.tracks.map((t) => ({
    ...t,
    clips: Array.isArray(t.clips) ? t.clips : [],
    activeClipId: t.activeClipId ?? null,
  }));
  return { ...raw, version: 2, tracks };
}
