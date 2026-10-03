import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Clip,
  ClipIssueInfo,
  FadeShape,
  FadeSpec,
  LevelState,
  ListenerState,
  NamedProject,
  ProjectDoc,
  SourceType,
  SpatialSettings,
  Track,
  UnlockState,
} from '../types';
import { engine } from '../lib/engineInstance';
import { DecodeError, ClipPlayError } from '../lib/audioEngine';
import * as idb from '../lib/idb';
import { SAMPLE_LABELS } from '../lib/samples';
import {
  ClipHistory,
  ClipValidationError,
  defaultClipFields,
  diagnoseClip,
  validateClipFields,
} from '../lib/clipEdit';

const COLORS = ['#e8734a', '#4ecdc4', '#ffe066', '#a78bfa', '#f472b6', '#34d399', '#60a5fa'];

const DEFAULT_SPATIAL: SpatialSettings = {
  distanceModel: 'inverse',
  refDistance: 1,
  rolloffFactor: 1,
  maxDistance: 30,
  positionTimeConstant: 0.06,
  hrtfIR: 'none',
};

const DEFAULT_LISTENER: ListenerState = {
  position: { x: 0, y: 0, z: 3 },
  yaw: 0,
  pitch: 0,
  earHeight: 0,
};

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

function sampleTrack(type: Exclude<SourceType, 'file'>, index: number): Track {
  const presets: Record<Exclude<SourceType, 'file'>, Partial<Track> & { position: Track['position'] }> = {
    pulse: { position: { x: -3, y: 0, z: 0 }, loop: true },
    tone: { position: { x: 3, y: 0, z: 0 }, loop: true },
    duoA: { position: { x: -2, y: 0, z: 0 }, loop: true },
    duoB: { position: { x: 2, y: 0, z: 0 }, loop: true },
  };
  const p = presets[type];
  return {
    id: uid('trk'),
    name: SAMPLE_LABELS[type],
    sourceType: type,
    loop: p.loop ?? true,
    muted: false,
    solo: false,
    gain: 0.9,
    channel: 0,
    color: COLORS[index % COLORS.length],
    position: { ...p.position },
    status: 'pending',
  };
}

function emptyDoc(): ProjectDoc {
  return {
    version: 1,
    tracks: [],
    clips: [],
    listener: { ...DEFAULT_LISTENER, position: { ...DEFAULT_LISTENER.position } },
    spatial: { ...DEFAULT_SPATIAL },
    busGain: 1,
    masterGain: 0.9,
    savedAt: 0,
  };
}

/** 兼容旧工程：无 clips 字段时补空数组；片段只引用声轨 id，绝不内嵌音频 */
function migrateDoc(d: ProjectDoc): ProjectDoc {
  return { ...d, clips: Array.isArray(d.clips) ? d.clips : [] };
}

const CLIP_COLORS = ['#7fd1ff', '#a78bfa', '#34d399', '#f472b6', '#ffe066', '#60a5fa'];

export interface ClipDraft {
  sourceStart: number;
  sourceEnd: number;
  fadeInDuration: number;
  fadeInShape: FadeShape;
  fadeOutDuration: number;
  fadeOutShape: FadeShape;
  loopEnabled: boolean;
  loopStart: number;
  loopCount: number; // Number.POSITIVE_INFINITY 表示持续
}

export interface ClipApi {
  createClip: (trackId: string) => Promise<string | null>;
  removeClip: (clipId: string) => void;
  selectClip: (clipId: string | null) => void;
  /** 仅更新本地草稿（拖拽时高频调用）：不写历史、不触碰引擎 */
  draftClip: (clipId: string, draft: Partial<ClipDraft>) => void;
  /** 提交草稿：非法范围/淡化/循环全部拒绝并返回原因，不改动既有片段 */
  commitClipEdit: (clipId: string, draft: Partial<ClipDraft>) => { ok: boolean; reasons: string[] };
  /** 丢弃草稿，回到当前已保存的编辑描述 */
  revertClipDraft: (clipId: string) => void;
  getDraft: (clipId: string) => ClipDraft | null;
  playClip: (clipId: string) => Promise<void>;
  pauseClip: (clipId: string) => void;
  stopClip: (clipId: string) => void;
  seekClip: (clipId: string, timelineT: number) => Promise<void>;
  toggleClip: (clipId: string) => Promise<void>;
  playAllClips: () => Promise<void>;
  stopAllClips: () => void;
  undoClip: () => void;
  redoClip: () => void;
  canUndoClip: boolean;
  canRedoClip: boolean;
  playingClipIds: Set<string>;
  pendingClipIds: Set<string>;
  clipErrors: Record<string, string>;
  getClipIssue: (clip: Clip) => ClipIssueInfo | null;
  getClipProgress: (clipId: string) => number;
}

export interface WorkbenchApi {
  doc: ProjectDoc;
  unlock: UnlockState;
  unlockError: string | null;
  playingIds: Set<string>;
  levels: LevelState;
  selectedId: string | null;
  projects: NamedProject[];
  loadedProjectId: string | null;
  loadedProjectName: string | null;
  saveState: 'idle' | 'saving' | 'saved';
  globalError: string | null;
  selectTrack: (id: string | null) => void;
  unlockAudio: () => Promise<void>;
  addSample: (type: Exclude<SourceType, 'file'>) => Promise<void>;
  addFiles: (files: FileList | File[]) => Promise<void>;
  removeTrack: (id: string) => Promise<void>;
  updateTrack: (id: string, patch: Partial<Track>) => void;
  moveTrack: (id: string, position: Track['position']) => void;
  setListener: (
    patch:
      | Partial<Omit<ListenerState, 'position'>>
      | { position: Partial<ListenerState['position']> },
  ) => void;
  setSpatial: (patch: Partial<SpatialSettings>) => void;
  setBusGain: (v: number) => void;
  setMasterGain: (v: number) => void;
  play: (id: string) => Promise<void>;
  pause: (id: string) => void;
  stop: (id: string) => void;
  seek: (id: string, offsetSec: number) => Promise<void>;
  togglePlay: (id: string) => Promise<void>;
  playAll: () => Promise<void>;
  stopAll: () => void;
  clearClips: () => void;
  saveProjectAs: (name: string) => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  newProject: () => Promise<void>;
  dismissGlobalError: () => void;
  selectedClipId: string | null;
  clipApi: ClipApi;
}

export function useWorkbench(): WorkbenchApi {
  const [doc, setDoc] = useState<ProjectDoc>(emptyDoc);
  const [unlock, setUnlock] = useState<UnlockState>('locked');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [playingIds, setPlayingIds] = useState<Set<string>>(new Set());
  const [levels, setLevels] = useState<LevelState>({ l: 0, r: 0, clipL: false, clipR: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [projects, setProjects] = useState<NamedProject[]>([]);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [loadedProjectName, setLoadedProjectName] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playingClipIds, setPlayingClipIds] = useState<Set<string>>(new Set());
  const [pendingClipIds, setPendingClipIds] = useState<Set<string>>(new Set());
  const [clipErrors, setClipErrors] = useState<Record<string, string>>({});
  const [historyTick, setHistoryTick] = useState(0);

  /** 片段编辑历史只保存编辑描述（无音频数据）；撤销/重做逐快照精确恢复 */
  const historyRef = useRef<ClipHistory>(new ClipHistory([]));
  const clipDraftsRef = useRef<Map<string, ClipDraft>>(new Map());
  const [draftTick, setDraftTick] = useState(0);

  const docRef = useRef(doc);
  docRef.current = doc;
  const initDone = useRef(false);

  // ---------- 初始化：恢复会话与工程列表，绝不自动播放 ----------
  useEffect(() => {
    // React StrictMode 会双重挂载；用标志保证只加载一次，cancelled 只阻止写状态
    if (initDone.current) return;
    initDone.current = true;
    let cancelled = false;
    (async () => {
      try {
        const [session, list] = await Promise.all([idb.loadSession(), idb.listProjects()]);
        if (cancelled) return;
        if (list) setProjects(list);
        if (session) {
          const migrated = migrateDoc(session);
          // 重载：恢复全部片段编辑描述，但播放状态一律归零（不自动播放）。
          // 文件轨标记 pending，待音频解锁后重新注入 Blob 解码。
          historyRef.current = new ClipHistory(migrated.clips, '已重载工程');
          setDoc({
            ...migrated,
            tracks: migrated.tracks.map((t) => ({
              ...t,
              status: 'pending',
              errorMessage: undefined,
            })),
          });
          setHistoryTick((n) => n + 1);
        }
      } catch (err) {
        if (!cancelled) {
          setGlobalError(`读取本地工程失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---------- 引擎事件订阅 ----------
  useEffect(() => engine.onUnlock(setUnlock), []);
  useEffect(() => engine.onLevels(setLevels), []);

  useEffect(() => {
    return engine.onEnded((trackId) => {
      setPlayingIds((prev) => {
        if (!prev.has(trackId)) return prev;
        const next = new Set(prev);
        next.delete(trackId);
        return next;
      });
    });
  }, []);

  // 片段自然结束 / 延迟编辑在安全边界生效 → 同步 UI 播放与待生效状态
  useEffect(
    () =>
      engine.onClipEnded((clipId) => {
        setPlayingClipIds((prev) => {
          if (!prev.has(clipId)) return prev;
          const next = new Set(prev);
          next.delete(clipId);
          return next;
        });
        setPendingClipIds((prev) => {
          if (!prev.has(clipId)) return prev;
          const next = new Set(prev);
          next.delete(clipId);
          return next;
        });
      }),
    [],
  );

  useEffect(
    () =>
      engine.onClipEditApplied((clipId) => {
        // 换源已在共用时钟边界完成：清除“待生效”提示
        setPendingClipIds((prev) => {
          if (!prev.has(clipId)) return prev;
          const next = new Set(prev);
          next.delete(clipId);
          return next;
        });
        setPlayingClipIds((prev) => new Set(prev).add(clipId));
      }),
    [],
  );

  // ---------- 全局参数同步到音频链 ----------
  useEffect(() => {
    engine.setSpatialSettings(doc.spatial);
  }, [doc.spatial]);

  useEffect(() => {
    engine.setListener(doc.listener);
  }, [doc.listener]);

  useEffect(() => {
    engine.setBusGain(doc.busGain);
  }, [doc.busGain]);

  useEffect(() => {
    engine.setMasterGain(doc.masterGain);
  }, [doc.masterGain]);

  // 声轨任意参数（位置/增益/静音/独奏/loop）实时同步到音频链：
  // syncTracks 只更新 AudioParam 与路由，不重建 source，移动不会重启音轨
  useEffect(() => {
    engine.syncTracks(doc.tracks);
  }, [doc.tracks]);

  // ---------- 解锁后：同步全部声轨（解码/合成 + 参数），但不播放 ----------
  useEffect(() => {
    if (unlock !== 'unlocked') return;
    let cancelled = false;
    (async () => {
      // 先把当前全局参数推入音频图（恢复工程后这些 effect 不会因解锁而重跑）
      engine.setSpatialSettings(docRef.current.spatial);
      engine.setListener(docRef.current.listener);
      engine.setBusGain(docRef.current.busGain);
      engine.setMasterGain(docRef.current.masterGain);

      // 注入文件 Blob
      for (const t of docRef.current.tracks) {
        if (t.sourceType === 'file' && t.blobKey && t.status !== 'ready') {
          try {
            const blob = await idb.getBlob(t.blobKey);
            if (blob) engine.setFileBlob(t.id, blob);
            else if (!cancelled) {
              // 独立原因：本地 Blob 丢失；片段编辑历史保留，不被抹掉
              engine.markBlobMissing(t.id);
              patchTrack(t.id, {
                status: 'decode-error',
                errorMessage: '本地音频 Blob 缺失（IndexedDB 中未找到原文件），片段编辑仍保留',
              });
            }
          } catch {
            if (!cancelled) {
              engine.markBlobMissing(t.id);
              patchTrack(t.id, {
                status: 'decode-error',
                errorMessage: '读取本地音频失败（存储不可用），片段编辑仍保留',
              });
            }
          }
        }
      }
      for (const t of docRef.current.tracks) {
        if (cancelled) return;
        try {
          await engine.ensureTrack(t);
          if (cancelled) return;
          // 解码期间声轨可能已被删除
          if (!docRef.current.tracks.some((x) => x.id === t.id)) {
            engine.removeTrack(t.id);
            continue;
          }
          const dur = engine.getDuration(t.id);
          const ch = engine.getChannelCount(t.id);
          patchTrack(t.id, {
            status: 'ready',
            errorMessage: undefined,
            duration: dur ?? t.duration,
            channels: ch ?? t.channels,
          });
        } catch (err) {
          if (cancelled) return;
          if (err instanceof DecodeError) {
            patchTrack(t.id, { status: 'decode-error', errorMessage: err.message });
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlock]);

  // ---------- 自动保存会话（参数，不保存播放状态），防抖 ----------
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!initDone.current) return;
    setSaveState('saving');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const snapshot: ProjectDoc = {
        ...docRef.current,
        savedAt: Date.now(),
      };
      try {
        await idb.saveSession(snapshot);
        setSaveState('saved');
        window.setTimeout(() => setSaveState('idle'), 1200);
      } catch {
        setSaveState('idle');
      }
    }, 500);
    return () => window.clearTimeout(saveTimer.current);
  }, [doc]);

  function patchTrack(id: string, patch: Partial<Track>) {
    setDoc((d) => ({
      ...d,
      tracks: d.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
  }

  const selectTrack = useCallback((id: string | null) => setSelectedId(id), []);

  const unlockAudio = useCallback(async () => {
    setUnlockError(null);
    try {
      await engine.resume();
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const addSample = useCallback(async (type: Exclude<SourceType, 'file'>) => {
    if (engine.unlock !== 'unlocked') {
      // 解锁失败时不继续；用户在遮罩上能看到明确错误
      await unlockAudio();
      if ((engine.unlock as UnlockState) !== 'unlocked') return;
    }
    const track = sampleTrack(type, docRef.current.tracks.length);
    setDoc((d) => ({ ...d, tracks: [...d.tracks, track] }));
    if (engine.unlock === 'unlocked') {
      try {
        await engine.ensureTrack(track);
        const dur = engine.getDuration(track.id);
        const ch = engine.getChannelCount(track.id);
        patchTrack(track.id, {
          status: 'ready',
          duration: dur ?? undefined,
          channels: ch ?? undefined,
        });
      } catch {
        patchTrack(track.id, { status: 'decode-error', errorMessage: '样例合成失败' });
      }
    }
    setSelectedId(track.id);
  }, [unlock, unlockAudio]);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = [...files];
      if (arr.length === 0) return;
      if (engine.unlock !== 'unlocked') {
        await unlockAudio();
        if ((engine.unlock as UnlockState) !== 'unlocked') return;
      }
      for (let i = 0; i < arr.length; i++) {
        const file = arr[i];
        const blobKey = uid('blob');
        const idx = docRef.current.tracks.length + i;
        const track: Track = {
          id: uid('trk'),
          name: file.name,
          sourceType: 'file',
          blobKey,
          originalFileName: file.name,
          loop: false,
          muted: false,
          solo: false,
          gain: 0.9,
          channel: 0,
          color: COLORS[idx % COLORS.length],
          position: {
            x: Math.cos((idx * 2 * Math.PI) / Math.max(arr.length, 1)) * 2.5,
            y: 0,
            z: Math.sin((idx * 2 * Math.PI) / Math.max(arr.length, 1)) * 2.5,
          },
          status: engine.unlock === 'unlocked' ? 'loading' : 'pending',
        };
        setDoc((d) => ({ ...d, tracks: [...d.tracks, track] }));
        try {
          await idb.putBlob(blobKey, file);
        } catch {
          patchTrack(track.id, {
            status: 'decode-error',
            errorMessage: '音频写入本地 IndexedDB 失败（浏览器存储可能已满）',
          });
          continue;
        }
        if (engine.unlock !== 'unlocked') continue;
        engine.setFileBlob(track.id, file);
        try {
          // 用户可能在解码期间删除了该声轨
          if (!docRef.current.tracks.some((x) => x.id === track.id)) continue;
          await engine.ensureTrack(track);
          if (!docRef.current.tracks.some((x) => x.id === track.id)) {
            engine.removeTrack(track.id);
            continue;
          }
          const dur = engine.getDuration(track.id);
          const ch = engine.getChannelCount(track.id);
          patchTrack(track.id, {
            status: 'ready',
            duration: dur ?? undefined,
            channels: ch ?? undefined,
          });
        } catch (err) {
          if (!docRef.current.tracks.some((x) => x.id === track.id)) continue;
          if (err instanceof DecodeError) {
            patchTrack(track.id, { status: 'decode-error', errorMessage: err.message });
          } else {
            patchTrack(track.id, {
              status: 'decode-error',
              errorMessage: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    },
    [unlock, unlockAudio],
  );

  const removeTrack = useCallback(async (id: string) => {
    const t = docRef.current.tracks.find((x) => x.id === id);
    engine.removeTrack(id);
    if (t?.blobKey) {
      try {
        await idb.deleteBlob(t.blobKey);
      } catch {
        /* 忽略清理失败 */
      }
    }
    setPlayingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setDoc((d) => ({ ...d, tracks: d.tracks.filter((x) => x.id !== id) }));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, []);

  const updateTrack = useCallback(
    (id: string, patch: Partial<Track>) => {
      const prev = docRef.current.tracks.find((x) => x.id === id);
      patchTrack(id, patch);
      // 切换所选输入声道需要重建输入图（splitter 接线改变）
      if (
        prev &&
        patch.channel !== undefined &&
        patch.channel !== prev.channel &&
        engine.unlock === 'unlocked'
      ) {
        const merged: Track = { ...prev, ...patch };
        void engine.rebuildVoiceGraph(merged).catch((err) => {
          if (err instanceof DecodeError) {
            patchTrack(id, { status: 'decode-error', errorMessage: err.message });
          }
        });
      }
    },
    [],
  );

  const moveTrack = useCallback((id: string, position: Track['position']) => {
    setDoc((d) => ({
      ...d,
      tracks: d.tracks.map((t) => (t.id === id ? { ...t, position: { ...position } } : t)),
    }));
  }, []);

  const setListener = useCallback(
    (patch: Partial<ListenerState> | { position: Partial<ListenerState['position']> }) => {
      setDoc((d) => {
        if ('position' in patch) {
          return {
            ...d,
            listener: {
              ...d.listener,
              position: { ...d.listener.position, ...(patch as { position: Partial<ListenerState['position']> }).position },
            },
          };
        }
        return { ...d, listener: { ...d.listener, ...(patch as Partial<ListenerState>) } };
      });
    },
    [],
  );

  const setSpatial = useCallback((patch: Partial<SpatialSettings>) => {
    setDoc((d) => ({ ...d, spatial: { ...d.spatial, ...patch } }));
  }, []);

  const setBusGain = useCallback((v: number) => {
    setDoc((d) => ({ ...d, busGain: v }));
  }, []);

  const setMasterGain = useCallback((v: number) => {
    setDoc((d) => ({ ...d, masterGain: v }));
  }, []);

  // ---------- 传输 ----------
  const play = useCallback(
    async (id: string) => {
      if (engine.unlock !== 'unlocked') await unlockAudio();
      const t = docRef.current.tracks.find((x) => x.id === id);
      if (!t || t.status === 'decode-error') return;
      try {
        await engine.playTrack(t);
        setPlayingIds((prev) => {
          const next = new Set(prev);
          next.add(id);
          return next;
        });
      } catch (err) {
        if (err instanceof DecodeError) {
          patchTrack(id, { status: 'decode-error', errorMessage: err.message });
        } else {
          setGlobalError(err instanceof Error ? err.message : String(err));
        }
      }
    },
    [unlockAudio],
  );

  const pause = useCallback((id: string) => {
    const t = docRef.current.tracks.find((x) => x.id === id);
    if (!t) return;
    engine.pauseTrack(t);
    setPlayingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const stop = useCallback((id: string) => {
    const t = docRef.current.tracks.find((x) => x.id === id);
    if (!t) return;
    engine.stopTrack(t);
    setPlayingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const seek = useCallback(
    async (id: string, offsetSec: number) => {
      const t = docRef.current.tracks.find((x) => x.id === id);
      if (!t) return;
      const wasPlaying = engine.isPlaying(id);
      await engine.seekTrack(t, offsetSec, wasPlaying);
      setPlayingIds((prev) => {
        const next = new Set(prev);
        if (wasPlaying) next.add(id);
        else next.delete(id);
        return next;
      });
    },
    [],
  );

  const togglePlay = useCallback(
    async (id: string) => {
      if (engine.isPlaying(id)) pause(id);
      else await play(id);
    },
    [pause, play],
  );

  const playAll = useCallback(async () => {
    if (engine.unlock !== 'unlocked') await unlockAudio();
    for (const t of docRef.current.tracks) {
      if (t.status === 'decode-error') continue;
      try {
        await engine.playTrack(t);
        setPlayingIds((prev) => new Set(prev).add(t.id));
      } catch (err) {
        if (err instanceof DecodeError) {
          patchTrack(t.id, { status: 'decode-error', errorMessage: err.message });
        }
      }
    }
  }, [unlockAudio]);

  const stopAll = useCallback(() => {
    for (const t of docRef.current.tracks) engine.stopTrack(t);
    setPlayingIds(new Set());
  }, []);

  const clearClips = useCallback(() => {
    engine.clearClipLatch();
    setLevels((l) => ({ ...l, clipL: false, clipR: false }));
  }, []);

  // ---------- 具名工程 ----------
  const refreshProjects = useCallback(async () => {
    setProjects(await idb.listProjects());
  }, []);

  const saveProjectAs = useCallback(
    async (name: string) => {
      const id = loadedProjectId ?? uid('proj');
      const named: NamedProject = {
        id,
        name: name.trim() || `工程 ${new Date().toLocaleString()}`,
        savedAt: Date.now(),
        doc: { ...docRef.current, savedAt: Date.now() },
      };
      await idb.saveProject(named);
      setLoadedProjectId(id);
      setLoadedProjectName(named.name);
      await refreshProjects();
    },
    [loadedProjectId, refreshProjects],
  );

  const loadProject = useCallback(
    async (id: string) => {
      const p = await idb.getProject(id);
      if (!p) return;
      // 先拆除当前声轨与片段播放节点（编辑描述不删）
      for (const t of docRef.current.tracks) engine.removeTrack(t.id);
      for (const c of docRef.current.clips) engine.removeClip(c.id);
      setPlayingIds(new Set());
      setPlayingClipIds(new Set());
      setPendingClipIds(new Set());
      setClipErrors({});
      clipDraftsRef.current = new Map();
      const restored: ProjectDoc = migrateDoc({
        ...p.doc,
        tracks: p.doc.tracks.map((t) => ({
          ...t,
          // 内置样例可重建；文件声轨等待 Blob 注入解码；载入后不自动播放
          status: 'pending' as Track['status'],
        })),
      });
      historyRef.current = new ClipHistory(restored.clips, `载入：${p.name}`);
      setHistoryTick((n) => n + 1);
      setDoc(restored);
      setLoadedProjectId(p.id);
      setLoadedProjectName(p.name);
      setSelectedId(null);
      setSelectedClipId(null);
      // 若已解锁，走一遍解锁同步逻辑（手动触发：状态不变，effect 不会重跑）
      if (engine.unlock === 'unlocked') {
        for (const t of restored.tracks) {
          if (t.sourceType === 'file' && t.blobKey) {
            const blob = await idb.getBlob(t.blobKey);
            if (blob) engine.setFileBlob(t.id, blob);
            else {
              engine.markBlobMissing(t.id);
              patchTrack(t.id, {
                status: 'decode-error',
                errorMessage: '本地音频 Blob 缺失（IndexedDB 中未找到原文件），片段编辑仍保留',
              });
            }
          }
          try {
            await engine.ensureTrack(t);
            patchTrack(t.id, {
              status: 'ready',
              duration: engine.getDuration(t.id) ?? t.duration,
              channels: engine.getChannelCount(t.id) ?? t.channels,
              errorMessage: undefined,
            });
          } catch (err) {
            if (err instanceof DecodeError) {
              patchTrack(t.id, { status: 'decode-error', errorMessage: err.message });
            }
          }
        }
      }
    },
    [],
  );

  const deleteProject = useCallback(
    async (id: string) => {
      await idb.deleteProject(id);
      if (loadedProjectId === id) {
        setLoadedProjectId(null);
        setLoadedProjectName(null);
      }
      await refreshProjects();
    },
    [loadedProjectId, refreshProjects],
  );

  const newProject = useCallback(async () => {
    for (const t of docRef.current.tracks) engine.removeTrack(t.id);
    for (const c of docRef.current.clips) engine.removeClip(c.id);
    setPlayingIds(new Set());
    setPlayingClipIds(new Set());
    setPendingClipIds(new Set());
    setClipErrors({});
    clipDraftsRef.current = new Map();
    historyRef.current = new ClipHistory([]);
    setHistoryTick((n) => n + 1);
    setDoc(emptyDoc());
    setLoadedProjectId(null);
    setLoadedProjectName(null);
    setSelectedId(null);
    setSelectedClipId(null);
  }, []);

  const dismissGlobalError = useCallback(() => setGlobalError(null), []);

  // ---------- 非破坏性片段 ----------

  const trackById = useCallback(
    (trackId: string) => docRef.current.tracks.find((x) => x.id === trackId),
    [],
  );

  const clipById = useCallback(
    (clipId: string) => docRef.current.clips.find((c) => c.id === clipId),
    [],
  );

  /** 以当前已知源时长做校验：先取引擎解码时长，回退声轨记录时长 */
  const knownDurationOf = useCallback((track: Track | undefined): number | null => {
    if (!track) return null;
    const live = engine.getDuration(track.id);
    if (live != null) return live;
    return track.duration ?? null;
  }, []);

  const getClipIssue = useCallback(
    (clip: Clip): ClipIssueInfo | null => {
      const tr = trackById(clip.trackId);
      return diagnoseClip(clip, tr, knownDurationOf(tr));
    },
    [trackById, knownDurationOf],
  );

  const clipToDraft = useCallback((clip: Clip): ClipDraft => {
    return {
      sourceStart: clip.sourceStart,
      sourceEnd: clip.sourceEnd,
      fadeInDuration: clip.fadeIn.duration,
      fadeInShape: clip.fadeIn.shape,
      fadeOutDuration: clip.fadeOut.duration,
      fadeOutShape: clip.fadeOut.shape,
      loopEnabled: clip.loop.enabled,
      loopStart: clip.loop.start,
      loopCount: clip.loop.count,
    };
  }, []);

  const getDraft = useCallback(
    (clipId: string): ClipDraft | null => {
      const cached = clipDraftsRef.current.get(clipId);
      if (cached) return cached;
      const clip = clipById(clipId);
      return clip ? clipToDraft(clip) : null;
    },
    [clipById, clipToDraft],
  );

  const selectClip = useCallback((clipId: string | null) => setSelectedClipId(clipId), []);

  const draftClip = useCallback(
    (clipId: string, draft: Partial<ClipDraft>) => {
      const clip = clipById(clipId);
      if (!clip) return;
      const base = clipDraftsRef.current.get(clipId) ?? clipToDraft(clip);
      clipDraftsRef.current.set(clipId, { ...base, ...draft });
      setDraftTick((n) => n + 1);
    },
    [clipById, clipToDraft],
  );

  const revertClipDraft = useCallback(
    (clipId: string) => {
      clipDraftsRef.current.delete(clipId);
      setDraftTick((n) => n + 1);
    },
    [],
  );

  /**
   * 提交片段编辑：
   *  1) 用当前源时长严格校验（非法范围/淡化越界或重叠/循环越界）；非法直接拒绝，
   *     返回全部原因，既有片段与原始 Blob 不变。
   *  2) 合法才写入编辑描述、revision+1、压入撤销历史（历史只存描述）。
   *  3) 正在播放时，引擎把编辑延迟到下一安全边界换源（不重启无关轨、无双重播放）。
   */
  const commitClipEdit = useCallback(
    (clipId: string, draft: Partial<ClipDraft>): { ok: boolean; reasons: string[] } => {
      const clip = clipById(clipId);
      if (!clip) return { ok: false, reasons: ['片段不存在'] };
      const tr = trackById(clip.trackId);
      const duration = knownDurationOf(tr) ?? clip.sourceDuration;
      const base = clipDraftsRef.current.get(clipId) ?? clipToDraft(clip);
      const d = { ...base, ...draft };
      const next: Clip = {
        ...clip,
        sourceStart: d.sourceStart,
        sourceEnd: d.sourceEnd,
        fadeIn: { duration: d.fadeInDuration, shape: d.fadeInShape } as FadeSpec,
        fadeOut: { duration: d.fadeOutDuration, shape: d.fadeOutShape } as FadeSpec,
        loop: {
          enabled: d.loopEnabled,
          start: d.loopStart,
          count: d.loopCount,
        },
      };
      try {
        validateClipFields(
          {
            sourceStart: next.sourceStart,
            sourceEnd: next.sourceEnd,
            fadeIn: next.fadeIn,
            fadeOut: next.fadeOut,
            loop: next.loop,
          },
          duration,
        );
      } catch (err) {
        if (err instanceof ClipValidationError) {
          return { ok: false, reasons: err.reasons };
        }
        throw err;
      }

      const revised: Clip = { ...next, revision: clip.revision + 1 };
      const nextClips = docRef.current.clips.map((c) => (c.id === clipId ? revised : c));
      historyRef.current.commit(nextClips, `编辑片段 ${revised.name}`);
      setHistoryTick((n) => n + 1);
      clipDraftsRef.current.delete(clipId);
      setDoc((doc) => ({ ...doc, clips: nextClips }));
      setClipErrors((m) => {
        if (!(clipId in m)) return m;
        const nm = { ...m };
        delete nm[clipId];
        return nm;
      });

      // 引擎层：未播放立即换描述；播放中延迟到安全边界
      if (engine.unlock === 'unlocked') {
        try {
          const res = engine.stageClipEdit(revised, tr);
          if (res.deferred) {
            setPendingClipIds((prev) => new Set(prev).add(clipId));
          }
        } catch (err) {
          if (err instanceof ClipPlayError) {
            setClipErrors((m) => ({ ...m, [clipId]: err.message }));
          }
        }
      }
      return { ok: true, reasons: [] };
    },
    [clipById, clipToDraft, knownDurationOf, trackById],
  );

  const createClip = useCallback(
    async (trackId: string): Promise<string | null> => {
      if (engine.unlock !== 'unlocked') {
        await unlockAudio();
        if ((engine.unlock as UnlockState) !== 'unlocked') return null;
      }
      const tr = trackById(trackId);
      if (!tr) return null;
      let duration = knownDurationOf(tr);
      if (duration == null) {
        try {
          await engine.ensureTrack(tr);
          duration = engine.getDuration(trackId) ?? tr.duration ?? null;
        } catch (err) {
          if (err instanceof DecodeError) {
            patchTrack(trackId, { status: 'decode-error', errorMessage: err.message });
            return null;
          }
        }
      }
      if (duration == null || duration <= 0) {
        setGlobalError('源时长未知或文件无法解码，不能建立片段（未生成任何静音占位）');
        return null;
      }
      const fields = defaultClipFields(duration);
      const idx = docRef.current.clips.length;
      const clip: Clip = {
        id: uid('clip'),
        trackId,
        name: `${tr.name} · 片段 ${idx + 1}`,
        color: CLIP_COLORS[idx % CLIP_COLORS.length],
        sourceDuration: duration,
        revision: 1,
        createdAt: Date.now(),
        ...fields,
      };
      const nextClips = [...docRef.current.clips, clip];
      historyRef.current.commit(nextClips, `新建片段 ${clip.name}`);
      setHistoryTick((n) => n + 1);
      setDoc((d) => ({ ...d, clips: nextClips }));
      setSelectedClipId(clip.id);
      return clip.id;
    },
    [knownDurationOf, trackById, unlockAudio],
  );

  const removeClip = useCallback((clipId: string) => {
    engine.removeClip(clipId);
    clipDraftsRef.current.delete(clipId);
    setPlayingClipIds((prev) => {
      const next = new Set(prev);
      next.delete(clipId);
      return next;
    });
    setPendingClipIds((prev) => {
      const next = new Set(prev);
      next.delete(clipId);
      return next;
    });
    setClipErrors((m) => {
      if (!(clipId in m)) return m;
      const nm = { ...m };
      delete nm[clipId];
      return nm;
    });
    setDoc((d) => {
      if (!d.clips.some((c) => c.id === clipId)) return d;
      const nextClips = d.clips.filter((c) => c.id !== clipId);
      historyRef.current.commit(nextClips, '删除片段');
      setHistoryTick((n) => n + 1);
      return { ...d, clips: nextClips };
    });
    setSelectedClipId((cur) => (cur === clipId ? null : cur));
  }, []);

  /** 撤销/恢复后把编辑描述应用到引擎（只换描述，绝不复制或改写音频） */
  const applyClipsToEngine = useCallback((clips: Clip[]) => {
    for (const clip of clips) {
      const tr = docRef.current.tracks.find((x) => x.id === clip.trackId);
      if (!tr) continue;
      try {
        const res = engine.stageClipEdit(clip, tr);
        if (res.deferred) {
          setPendingClipIds((prev) => new Set(prev).add(clip.id));
        } else {
          setPendingClipIds((prev) => {
            if (!prev.has(clip.id)) return prev;
            const next = new Set(prev);
            next.delete(clip.id);
            return next;
          });
        }
      } catch {
        /* 源未就绪（未解锁/缺失）：描述仍已恢复，待解锁后生效 */
      }
    }
  }, []);

  const undoClip = useCallback(() => {
    const r = historyRef.current.undo();
    if (!r) return;
    setHistoryTick((n) => n + 1);
    clipDraftsRef.current = new Map();
    setDoc((d) => ({ ...d, clips: r.clips }));
    applyClipsToEngine(r.clips);
  }, [applyClipsToEngine]);

  const redoClip = useCallback(() => {
    const r = historyRef.current.redo();
    if (!r) return;
    setHistoryTick((n) => n + 1);
    clipDraftsRef.current = new Map();
    setDoc((d) => ({ ...d, clips: r.clips }));
    applyClipsToEngine(r.clips);
  }, [applyClipsToEngine]);

  const playClip = useCallback(
    async (clipId: string) => {
      if (engine.unlock !== 'unlocked') await unlockAudio();
      const clip = clipById(clipId);
      if (!clip) return;
      const tr = trackById(clip.trackId);
      try {
        await engine.playClip(clip, tr);
        setPlayingClipIds((prev) => new Set(prev).add(clipId));
        setClipErrors((m) => {
          if (!(clipId in m)) return m;
          const nm = { ...m };
          delete nm[clipId];
          return nm;
        });
      } catch (err) {
        if (err instanceof ClipPlayError) {
          setClipErrors((m) => ({ ...m, [clipId]: err.message }));
        } else {
          setGlobalError(err instanceof Error ? err.message : String(err));
        }
      }
    },
    [clipById, trackById, unlockAudio],
  );

  const pauseClip = useCallback((clipId: string) => {
    engine.pauseClip(clipId);
    setPlayingClipIds((prev) => {
      const next = new Set(prev);
      next.delete(clipId);
      return next;
    });
    setPendingClipIds((prev) => {
      const next = new Set(prev);
      next.delete(clipId);
      return next;
    });
  }, []);

  const stopClip = useCallback((clipId: string) => {
    engine.stopClip(clipId);
    setPlayingClipIds((prev) => {
      const next = new Set(prev);
      next.delete(clipId);
      return next;
    });
    setPendingClipIds((prev) => {
      const next = new Set(prev);
      next.delete(clipId);
      return next;
    });
  }, []);

  const seekClip = useCallback(
    async (clipId: string, timelineT: number) => {
      const clip = clipById(clipId);
      if (!clip) return;
      const tr = trackById(clip.trackId);
      const wasPlaying = engine.isClipPlaying(clipId);
      await engine.seekClip(clip, tr, timelineT, wasPlaying);
      setPlayingClipIds((prev) => {
        const next = new Set(prev);
        if (wasPlaying) next.add(clipId);
        else next.delete(clipId);
        return next;
      });
    },
    [clipById, trackById],
  );

  const toggleClip = useCallback(
    async (clipId: string) => {
      if (engine.isClipPlaying(clipId)) pauseClip(clipId);
      else await playClip(clipId);
    },
    [pauseClip, playClip],
  );

  /** 多片段在同一 AudioContext 时钟上一次性调度；失败片段各自给独立原因，不以静音充数 */
  const playAllClips = useCallback(async () => {
    if (engine.unlock !== 'unlocked') await unlockAudio();
    const items = docRef.current.clips.map((clip) => ({
      clip,
      track: docRef.current.tracks.find((t) => t.id === clip.trackId),
    }));
    if (items.length === 0) return;
    const results = await engine.playClips(items);
    const okIds = new Set<string>();
    const errMap: Record<string, string> = {};
    for (const r of results) {
      if (r.error) errMap[r.clipId] = r.error.message;
      else okIds.add(r.clipId);
    }
    setPlayingClipIds((prev) => {
      const next = new Set(prev);
      okIds.forEach((id) => next.add(id));
      return next;
    });
    setClipErrors((m) => {
      const nm = { ...m };
      for (const id of okIds) delete nm[id];
      Object.assign(nm, errMap);
      return nm;
    });
  }, [unlockAudio]);

  const stopAllClips = useCallback(() => {
    for (const c of docRef.current.clips) engine.stopClip(c.id);
    setPlayingClipIds(new Set());
    setPendingClipIds(new Set());
  }, []);

  const getClipProgress = useCallback((clipId: string): number => engine.getClipProgress(clipId), []);

  const clipApi = useMemo<ClipApi>(
    () => ({
      createClip,
      removeClip,
      selectClip,
      draftClip,
      commitClipEdit,
      revertClipDraft,
      getDraft,
      playClip,
      pauseClip,
      stopClip,
      seekClip,
      toggleClip,
      playAllClips,
      stopAllClips,
      undoClip,
      redoClip,
      canUndoClip: historyRef.current.canUndo,
      canRedoClip: historyRef.current.canRedo,
      playingClipIds,
      pendingClipIds,
      clipErrors,
      getClipIssue,
      getClipProgress,
    }),
    // historyTick/draftTick：historyRef/draftsRef 变化不在依赖里，用 tick 强制刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      historyTick,
      draftTick,
      playingClipIds,
      pendingClipIds,
      clipErrors,
      createClip,
      removeClip,
      selectClip,
      draftClip,
      commitClipEdit,
      revertClipDraft,
      playClip,
      pauseClip,
      stopClip,
      seekClip,
      toggleClip,
      playAllClips,
      stopAllClips,
      undoClip,
      redoClip,
      getClipIssue,
      getClipProgress,
    ],
  );

  const api = useMemo<WorkbenchApi>(
    () => ({
      doc,
      unlock,
      unlockError,
      playingIds,
      levels,
      selectedId,
      projects,
      loadedProjectId,
      loadedProjectName,
      saveState,
      globalError,
      selectTrack,
      unlockAudio,
      addSample,
      addFiles,
      removeTrack,
      updateTrack,
      moveTrack,
      setListener,
      setSpatial,
      setBusGain,
      setMasterGain,
      play,
      pause,
      stop,
      seek,
      togglePlay,
      playAll,
      stopAll,
      clearClips,
      saveProjectAs,
      loadProject,
      deleteProject,
      newProject,
      dismissGlobalError,
      selectedClipId,
      clipApi,
    }),
    [
      doc,
      unlock,
      unlockError,
      playingIds,
      levels,
      selectedId,
      projects,
      loadedProjectId,
      loadedProjectName,
      saveState,
      globalError,
      selectTrack,
      unlockAudio,
      addSample,
      addFiles,
      removeTrack,
      updateTrack,
      moveTrack,
      setListener,
      setSpatial,
      setBusGain,
      setMasterGain,
      play,
      pause,
      stop,
      seek,
      togglePlay,
      playAll,
      stopAll,
      clearClips,
      saveProjectAs,
      loadProject,
      deleteProject,
      newProject,
      dismissGlobalError,
      selectedClipId,
      clipApi,
    ],
  );

  return api;
}
