/** 共享类型定义 */

export type DistanceModel = 'exponential' | 'inverse' | 'linear';

export type SourceType = 'file' | 'pulse' | 'tone' | 'duoA' | 'duoB';

export type TrackStatus =
  | 'pending' // 等待音频解锁后解码/生成
  | 'loading'
  | 'ready'
  | 'decode-error';

/** 淡化曲线：linear 等幅；equalPower 等功率（sin/cos 余弦平权） */
export type FadeCurve = 'linear' | 'equalPower';

export interface ClipFade {
  /** 淡化长度（秒），0 表示无淡化 */
  length: number;
  curve: FadeCurve;
}

export interface ClipLoop {
  enabled: boolean;
  /** 循环入点/出点（原始文件时间轴，秒），必须落在片段 [inPoint, outPoint] 内 */
  inPoint: number;
  outPoint: number;
}

/** 片段提交草稿（与持久化对象分开：尚未分配 id/版本） */
export interface ClipDraft {
  inPoint: number;
  outPoint: number;
  fadeIn: ClipFade;
  fadeOut: ClipFade;
  loop: ClipLoop;
}

/**
 * 非破坏性片段：只引用既有声轨与原始时间范围，绝不复制/裁切采样。
 * 所有数值都在「原始 Blob/缓冲时间轴」上，撤销/重做只改本描述。
 */
export interface Clip {
  id: string;
  name: string;
  /** 引用的声轨 id（音频只在该轨的原始缓冲上读取） */
  trackId: string;
  /** 原始时间轴入点（秒） */
  inPoint: number;
  /** 原始时间轴出点（秒，不含） */
  outPoint: number;
  fadeIn: ClipFade;
  fadeOut: ClipFade;
  loop: ClipLoop;
  /** 创建/最近校准时记录的原文件时长；用于重载后检测原文件时长变化。null = 原时长未知 */
  sourceDuration: number | null;
  /** 编辑描述版本：每次已提交的边界/淡化/循环修改 +1 */
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface Track {
  id: string;
  name: string;
  sourceType: SourceType;
  /** file 类型时为 IDB 中的 Blob 键；内置样例重新生成，不需要持久化音频 */
  blobKey?: string;
  originalFileName?: string;
  loop: boolean;
  muted: boolean;
  solo: boolean;
  /** 推子线性增益（0..1.5），真实进入音频链 */
  gain: number;
  /** 立体声文件选用的输入声道：HRTF 需要单声道输入 */
  channel: number;
  /** 解码后文件的声道数（决定 UI 是否显示 L/R 选择） */
  channels?: number;
  /** UI 颜色 */
  color: string;
  /** 声源世界坐标，单位米，右手系：+X 右，+Y 上，+Z 朝向屏幕（听者后方） */
  position: Vec3;
  status: TrackStatus;
  errorMessage?: string;
  duration?: number;
  /** 非破坏性片段（只含编辑描述，随工程持久化；不含任何音频数据） */
  clips: Clip[];
  /** 当前用于试听的片段 id；null = 整轨原始范围播放 */
  activeClipId: string | null;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ListenerState {
  position: Vec3;
  /** 偏航角（弧度），绕世界 +Y 轴；yaw=0 时朝向 -Z（屏幕内） */
  yaw: number;
  /** 俯仰角（弧度），绕本地右向量，正为向上看 */
  pitch: number;
  /** 听者耳高基准（暂以 position.y 为准，保留字段） */
  earHeight: number;
}

export interface SpatialSettings {
  distanceModel: DistanceModel;
  refDistance: number;
  rolloffFactor: number;
  maxDistance: number;
  /** PannerNode 内部平滑时间（秒），移动时不中断音频 */
  positionTimeConstant: number;
  /** HRTF 内部分辨率（部分浏览器不支持读取/设置则忽略） */
  hrtfIR: 'none';
}

export interface ProjectDoc {
  /** 1 = 原始整轨工程；2 = 含非破坏性片段描述 */
  version: 2;
  tracks: Track[];
  listener: ListenerState;
  spatial: SpatialSettings;
  busGain: number;
  masterGain: number;
  savedAt: number;
  name?: string;
}

/** 片段层面的独立问题（与解码失败分开，不抹掉编辑历史） */
export type ClipIssueKind =
  | 'source-missing' // IndexedDB 中的原始 Blob 已丢失
  | 'decode-error' // 原始文件解码失败
  | 'duration-changed' // 原文件时长已变化，片段边界不再可解释
  | 'not-ready'; // 尚未解锁/解码，暂不可试听（描述仍可审阅/编辑）

export interface ClipIssue {
  kind: ClipIssueKind;
  message: string;
}

export interface NamedProject {
  id: string;
  name: string;
  savedAt: number;
  doc: ProjectDoc;
}

export interface LevelState {
  /** 线性峰值 0..1+ */
  l: number;
  r: number;
  /** 锁存的削波标记（任意采样 >= 1.0） */
  clipL: boolean;
  clipR: boolean;
}

export type UnlockState = 'locked' | 'unlocking' | 'unlocked' | 'failed';

export interface ProgressInfo {
  trackId: string;
  current: number;
  duration: number;
}
