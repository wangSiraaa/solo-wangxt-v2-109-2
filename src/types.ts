/** 共享类型定义 */

export type DistanceModel = 'exponential' | 'inverse' | 'linear';

export type SourceType = 'file' | 'pulse' | 'tone' | 'duoA' | 'duoB';

export type TrackStatus =
  | 'pending' // 等待音频解锁后解码/生成
  | 'loading'
  | 'ready'
  | 'decode-error';

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
  version: 1;
  tracks: Track[];
  /** 非破坏性片段：只引用声轨与原始时间范围，含裁切/淡化/循环/版本描述 */
  clips: Clip[];
  listener: ListenerState;
  spatial: SpatialSettings;
  busGain: number;
  masterGain: number;
  savedAt: number;
  name?: string;
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

// ---------- 非破坏性片段 ----------

/** 淡化曲线形状（均由引擎按时间线逐点生成增益曲线，不修改源缓冲） */
export type FadeShape = 'linear' | 'equalPower' | 'exponential';

export interface FadeSpec {
  /** 淡化时长（秒），0 = 无淡化 */
  duration: number;
  shape: FadeShape;
}

export interface ClipLoop {
  /** 是否循环 */
  enabled: boolean;
  /** 循环回跳点（原始音频时间，秒），必须位于入点与出点之间 */
  start: number;
  /** 循环次数（含首次整段）：正整数；Number.POSITIVE_INFINITY 表示持续循环 */
  count: number;
}

/**
 * 片段 = 对既有声轨原始时间范围的“只读引用 + 编辑描述”。
 * 绝不复制、改写 IndexedDB 中的原始 Blob；撤销/重做只恢复本描述。
 */
export interface Clip {
  id: string;
  /** 引用的声轨 id（源缓冲按轨共享，同一份解码数据） */
  trackId: string;
  name: string;
  color: string;
  /** 入点：原始音频时间（秒） */
  sourceStart: number;
  /** 出点：原始音频时间（秒，不含） */
  sourceEnd: number;
  fadeIn: FadeSpec;
  fadeOut: FadeSpec;
  loop: ClipLoop;
  /** 编辑描述版本号：每次成功提交 +1；撤销/重做连同本号精确恢复 */
  revision: number;
  /** 创建时记录的源时长（秒）；重载后与当前解码时长对比，识别“原文件时长变化” */
  sourceDuration: number;
  createdAt: number;
}

/** 片段无法正常试听的独立原因（运行态，不持久化、不影响编辑历史） */
export type ClipIssue =
  | 'missing-source' // 引用的声轨已不存在
  | 'source-missing-blob' // 本地 IndexedDB 中的原始 Blob 丢失
  | 'source-decode-error' // 原始文件解码失败
  | 'source-changed' // 原文件时长相对建片段时已变化（警告）
  | 'out-of-range'; // 片段范围超出当前源时长（阻断播放，避免静音假成功）

export interface ClipIssueInfo {
  issue: ClipIssue;
  detail?: string;
}
