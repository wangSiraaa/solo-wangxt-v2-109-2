/**
 * 片段编辑历史（纯数据，无副作用）：撤销/重做只回放编辑描述快照，
 * 绝不触碰 IndexedDB Blob 或任何音频缓冲。
 * 快照在入栈时已做结构化拷贝，重复撤销/重做只是引用同一份不可变描述，
 * 因此不会产生浮点/边界的累积误差。
 */
import type { Clip } from '../types';

export type ClipHistoryEntry =
  | { type: 'create'; trackId: string; clip: Clip }
  | { type: 'update'; trackId: string; before: Clip; after: Clip }
  | { type: 'delete'; trackId: string; clip: Clip };

/** 编辑描述深拷贝：仅普通数值/字符串，无音频数据 */
export function cloneClip(clip: Clip): Clip {
  return {
    ...clip,
    fadeIn: { ...clip.fadeIn },
    fadeOut: { ...clip.fadeOut },
    loop: { ...clip.loop },
  };
}

/**
 * 在一条声轨的片段表上回放历史条目。
 * @param dir undo = 回到旧状态；redo = 走向新状态
 * @returns 新的片段表（不可变更新）
 */
export function applyEntryToClips(
  clips: readonly Clip[],
  entry: ClipHistoryEntry,
  dir: 'undo' | 'redo',
): Clip[] {
  if (entry.type === 'create') {
    // 撤销 create = 删除；重做 create = 加回（原快照，id 不变）
    if (dir === 'undo') return clips.filter((c) => c.id !== entry.clip.id);
    return [...clips, cloneClip(entry.clip)];
  }
  if (entry.type === 'delete') {
    // 撤销 delete = 加回；重做 delete = 删除
    if (dir === 'redo') return clips.filter((c) => c.id !== entry.clip.id);
    return [...clips, cloneClip(entry.clip)];
  }
  // update：undo 精确恢复 before，redo 精确恢复 after（整体替换，无增量叠加）
  const target = dir === 'undo' ? entry.before : entry.after;
  return clips.map((c) => (c.id === target.id ? cloneClip(target) : c));
}

/** 若回放会移除当前活动片段，调用方应把 activeClipId 置空 */
export function entryRemovesClip(entry: ClipHistoryEntry, dir: 'undo' | 'redo'): string | null {
  const removingCreate = entry.type === 'create' && dir === 'undo';
  const removingDelete = entry.type === 'delete' && dir === 'redo';
  return removingCreate || removingDelete ? entry.clip.id : null;
}
