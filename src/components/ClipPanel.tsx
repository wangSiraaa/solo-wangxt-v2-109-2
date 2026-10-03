import { useRef, useState } from 'react';
import type { Clip, ClipDraft, FadeCurve, Track } from '../types';
import type { WorkbenchApi } from '../state/useWorkbench';
import { getClipIssue } from '../lib/clip';

interface Props {
  track: Track;
  api: WorkbenchApi;
}

const CURVES: { value: FadeCurve; label: string }[] = [
  { value: 'linear', label: '线性' },
  { value: 'equalPower', label: '等功率' },
];

function fmt(t: number): string {
  if (!Number.isFinite(t)) return '--';
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
}

/** 编辑草稿：拖拽期间本地保存，点击“提交裁切”才校验入库（非法即拒绝） */
export function ClipPanel({ track, api }: Props) {
  const [selectedClipId, setSelectedClipId] = useState<string | null>(
    track.clips[0]?.id ?? null,
  );
  const clip = track.clips.find((c) => c.id === selectedClipId) ?? null;
  const duration = track.duration ?? null;

  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftData, setDraftData] = useState<ClipDraft | null>(null);
  const [rejectMsg, setRejectMsg] = useState<string[] | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    mode: 'in' | 'out' | 'fadeIn' | 'fadeOut' | 'loopIn' | 'loopOut' | 'body';
    startX: number;
    origin: ClipDraft;
  } | null>(null);

  const editing: ClipDraft | null =
    draftData ??
    (clip
      ? {
          inPoint: clip.inPoint,
          outPoint: clip.outPoint,
          fadeIn: { ...clip.fadeIn },
          fadeOut: { ...clip.fadeOut },
          loop: { ...clip.loop },
        }
      : null);

  const beginCreate = () => {
    if (duration == null) return;
    setDraftData({
      inPoint: 0,
      outPoint: duration,
      fadeIn: { length: 0.02, curve: 'linear' },
      fadeOut: { length: 0.02, curve: 'linear' },
      loop: { enabled: false, inPoint: 0, outPoint: duration },
    });
    setDraftId('new');
    setRejectMsg(null);
    setSelectedClipId(null);
  };

  const editClip = (clip0: Clip) => {
    setSelectedClipId(clip0.id);
    setDraftId(clip0.id);
    setDraftData({
      inPoint: clip0.inPoint,
      outPoint: clip0.outPoint,
      fadeIn: { ...clip0.fadeIn },
      fadeOut: { ...clip0.fadeOut },
      loop: { ...clip0.loop },
    });
    setRejectMsg(null);
  };

  const patchDraft = (p: Partial<ClipDraft>) =>
    setDraftData((d: ClipDraft | null) => (d ? { ...d, ...p } : d));

  // ---------- 时间轴拖拽 ----------
  const pxToTime = (clientX: number): number => {
    const el = barRef.current;
    if (!el || duration == null) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  const onPointerDown =
    (mode: NonNullable<typeof dragRef.current>['mode']) =>
    (e: React.PointerEvent) => {
      if (!editing || duration == null) return;
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      dragRef.current = { mode, startX: e.clientX, origin: editing };
    };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = dragRef.current;
    if (!g || !editing || duration == null) return;
    const t = pxToTime(e.clientX);
    const o = g.origin;
    const next: ClipDraft = {
      ...editing,
      fadeIn: { ...editing.fadeIn },
      fadeOut: { ...editing.fadeOut },
      loop: { ...editing.loop },
    };
    switch (g.mode) {
      case 'in':
        next.inPoint = t;
        break;
      case 'out':
        next.outPoint = t;
        break;
      case 'fadeIn':
        next.fadeIn = { ...next.fadeIn, length: Math.max(0, t - next.inPoint) };
        break;
      case 'fadeOut':
        next.fadeOut = { ...next.fadeOut, length: Math.max(0, next.outPoint - t) };
        break;
      case 'loopIn':
        next.loop = { ...next.loop, inPoint: t };
        break;
      case 'loopOut':
        next.loop = { ...next.loop, outPoint: t };
        break;
      case 'body': {
        // 平移整段（保持长度/淡化/循环相对偏移）
        const dt = t - pxToTime(g.startX);
        const len = o.outPoint - o.inPoint;
        const inP = Math.min(Math.max(0, o.inPoint + dt), Math.max(0, duration - len));
        const shift = inP - o.inPoint;
        next.inPoint = inP;
        next.outPoint = inP + len;
        if (next.loop.enabled) {
          next.loop = {
            ...next.loop,
            inPoint: o.loop.inPoint + shift,
            outPoint: o.loop.outPoint + shift,
          };
        }
        break;
      }
    }
    setDraftData(next);
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  // ---------- 提交 ----------
  const submit = () => {
    if (!editing) return;
    if (draftId && draftId !== 'new' && clip) {
      const issues = api.commitClip(track.id, clip.id, editing);
      if (issues.length) {
        setRejectMsg(issues); // 提交被拒绝：草稿/原片段都保留，原 Blob 不动
        return;
      }
    } else {
      const res = api.createClip(track.id, editing);
      if (!res.ok) {
        setRejectMsg(res.issues);
        return;
      }
      setSelectedClipId(res.clipId);
    }
    setRejectMsg(null);
    setDraftData(null);
    setDraftId(null);
  };

  const cancel = () => {
    setDraftData(null);
    setDraftId(null);
    setRejectMsg(null);
  };

  const ready = duration != null;
  const issue = clip ? getClipIssue(track, clip, api.unlock === 'unlocked') : null;
  const pct = (t: number) => (duration ? `${(t / duration) * 100}%` : '0%');
  const d = editing;
  // 片段区域内部的相对百分比（淡化/循环条挂在片段区域里，须按片段长度归一）
  const clipLen = d ? Math.max(1e-6, d.outPoint - d.inPoint) : 1;
  const rel = (t: number) => `${(t / clipLen) * 100}%`;

  return (
    <div className="panel clip-panel">
      <div className="panel-title">
        <span className="track-color" style={{ background: track.color }} />
        非破坏性片段 · {track.name}
      </div>

      <div className="clip-toolbar">
        <button className="btn mini" onClick={beginCreate} disabled={!ready} title={ready ? '' : '原音频就绪后才能建立片段'}>
          ＋ 新建片段
        </button>
        <button
          className="btn mini ghost"
          onClick={api.undo}
          disabled={!api.canUndoClips}
          title="撤销片段编辑（只改编辑描述）"
        >
          ↶ 撤销
        </button>
        <button
          className="btn mini ghost"
          onClick={api.redo}
          disabled={!api.canRedoClips}
          title="恢复片段编辑"
        >
          ↷ 恢复
        </button>
      </div>

      {track.clips.length > 0 && (
        <ul className="clip-list">
          {track.clips.map((c) => {
            const ci = getClipIssue(track, c, api.unlock === 'unlocked');
            return (
              <li
                key={c.id}
                className={`clip-item ${selectedClipId === c.id ? 'active' : ''}`}
                onClick={() => {
                  setSelectedClipId(c.id);
                  setDraftId(c.id);
                  setDraftData({
                    inPoint: c.inPoint,
                    outPoint: c.outPoint,
                    fadeIn: { ...c.fadeIn },
                    fadeOut: { ...c.fadeOut },
                    loop: { ...c.loop },
                  });
                  setRejectMsg(null);
                }}
              >
                <span className="clip-item-name">{c.name}</span>
                <span className="muted small">
                  {fmt(c.inPoint)}–{fmt(c.outPoint)}
                  {c.loop.enabled ? ` ↻${fmt(c.loop.inPoint)}–${fmt(c.loop.outPoint)}` : ''} · v{c.version}
                </span>
                {ci && <span className={`clip-issue-dot ${ci.kind}`} title={ci.message}>⚠</span>}
                <button
                  className={`btn mini ${track.activeClipId === c.id ? 'active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    api.setActiveClip(track.id, track.activeClipId === c.id ? null : c.id);
                  }}
                  title="设为该轨试听片段（传输条按片段边界播放）"
                >
                  {track.activeClipId === c.id ? '试听中' : '选用'}
                </button>
                <button className="btn mini ghost" onClick={(e) => { e.stopPropagation(); editClip(c); }}>
                  编辑
                </button>
                <button className="btn mini ghost" onClick={(e) => { e.stopPropagation(); api.duplicateClip(track.id, c.id); }}>
                  复制
                </button>
                <button
                  className="btn mini primary"
                  disabled={!!ci}
                  onClick={(e) => {
                    e.stopPropagation();
                    void api.playClip(track.id, c.id);
                  }}
                  title={ci ? ci.message : '播放片段'}
                >
                  ▶
                </button>
                <button className="btn mini ghost danger" onClick={(e) => { e.stopPropagation(); api.removeClip(track.id, c.id); }}>
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {issue && (
        <div className={`clip-issue ${issue.kind}`}>
          <b>
            {issue.kind === 'source-missing'
              ? '原始文件丢失'
              : issue.kind === 'decode-error'
                ? '解码失败'
                : issue.kind === 'duration-changed'
                  ? '原文件时长变化'
                  : '暂不可试听'}
          </b>
          ：{issue.message}
        </div>
      )}

      {draftId !== null && d && duration != null && (
        <div className="clip-editor">
          <div className="clip-range-hint muted small">
            可审阅时间区域（原始文件时间轴，总长 {fmt(duration)}s）：拖动手柄调整，提交时校验
          </div>
          <div
            className="clip-timeline"
            ref={barRef}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div className="clip-timeline-ruler" />
            <div
              className="clip-region"
              style={{ left: pct(d.inPoint), width: pct(d.outPoint - d.inPoint) }}
              onPointerDown={onPointerDown('body')}
            >
              {d.fadeIn.length > 0 && (
                <div
                  className="clip-fade in"
                  style={{ width: rel(Math.min(d.fadeIn.length, clipLen)) }}
                  onPointerDown={onPointerDown('fadeIn')}
                  title={`淡入 ${d.fadeIn.length.toFixed(3)}s（拖右边缘改长度）`}
                />
              )}
              {d.fadeOut.length > 0 && (
                <div
                  className="clip-fade out"
                  style={{ width: rel(Math.min(d.fadeOut.length, clipLen)) }}
                  onPointerDown={onPointerDown('fadeOut')}
                  title={`淡出 ${d.fadeOut.length.toFixed(3)}s（拖左边缘改长度）`}
                />
              )}
              {d.loop.enabled && (
                <div
                  className="clip-loop-region"
                  style={{
                    left: rel(Math.max(0, d.loop.inPoint - d.inPoint)),
                    width: rel(Math.max(0, d.loop.outPoint - d.loop.inPoint)),
                  }}
                  title="循环区间"
                >
                  <span className="loop-handle l" onPointerDown={onPointerDown('loopIn')} />
                  <span className="loop-handle r" onPointerDown={onPointerDown('loopOut')} />
                </div>
              )}
              <span className="edge-handle in" onPointerDown={onPointerDown('in')} />
              <span className="edge-handle out" onPointerDown={onPointerDown('out')} />
            </div>
          </div>

          <div className="clip-fields">
            <label>
              入点
              <input
                type="number"
                step={0.01}
                value={Number(d.inPoint.toFixed(3))}
                onChange={(e) => patchDraft({ inPoint: Number(e.target.value) })}
              />
            </label>
            <label>
              出点
              <input
                type="number"
                step={0.01}
                value={Number(d.outPoint.toFixed(3))}
                onChange={(e) => patchDraft({ outPoint: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="clip-fields">
            <label>
              淡入 s
              <input
                type="number"
                step={0.01}
                min={0}
                value={Number(d.fadeIn.length.toFixed(3))}
                onChange={(e) =>
                  patchDraft({ fadeIn: { ...d.fadeIn, length: Number(e.target.value) } })
                }
              />
            </label>
            <select
              value={d.fadeIn.curve}
              onChange={(e) =>
                patchDraft({ fadeIn: { ...d.fadeIn, curve: e.target.value as FadeCurve } })
              }
            >
              {CURVES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <label>
              淡出 s
              <input
                type="number"
                step={0.01}
                min={0}
                value={Number(d.fadeOut.length.toFixed(3))}
                onChange={(e) =>
                  patchDraft({ fadeOut: { ...d.fadeOut, length: Number(e.target.value) } })
                }
              />
            </label>
            <select
              value={d.fadeOut.curve}
              onChange={(e) =>
                patchDraft({ fadeOut: { ...d.fadeOut, curve: e.target.value as FadeCurve } })
              }
            >
              {CURVES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="clip-fields">
            <label className="clip-loop-check">
              <input
                type="checkbox"
                checked={d.loop.enabled}
                onChange={(e) =>
                  patchDraft({
                    loop: {
                      enabled: e.target.checked,
                      inPoint: d.inPoint,
                      outPoint: d.outPoint,
                    },
                  })
                }
              />
              循环区间
            </label>
            {d.loop.enabled && (
              <>
                <label>
                  循环入
                  <input
                    type="number"
                    step={0.01}
                    value={Number(d.loop.inPoint.toFixed(3))}
                    onChange={(e) =>
                      patchDraft({ loop: { ...d.loop, inPoint: Number(e.target.value) } })
                    }
                  />
                </label>
                <label>
                  循环出
                  <input
                    type="number"
                    step={0.01}
                    value={Number(d.loop.outPoint.toFixed(3))}
                    onChange={(e) =>
                      patchDraft({ loop: { ...d.loop, outPoint: Number(e.target.value) } })
                    }
                  />
                </label>
              </>
            )}
          </div>

          <div className="clip-length muted small">
            片段长度 {fmt(Math.max(0, d.outPoint - d.inPoint))}s
            （只引用原轨 {fmt(d.inPoint)}–{fmt(d.outPoint)}，不复制采样）
          </div>

          {rejectMsg && (
            <div className="clip-reject">
              <b>提交被拒绝</b>（原片段与原始 Blob 完好）：
              <ul>
                {rejectMsg.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="clip-actions">
            <button className="btn small primary" onClick={submit}>
              提交裁切
            </button>
            <button className="btn small ghost" onClick={cancel}>
              取消
            </button>
          </div>
        </div>
      )}

      {!ready && (
        <p className="muted small">原音频就绪（解锁并解码）后可建立/拖裁片段；已有片段定义仍可在此审阅。</p>
      )}
    </div>
  );
}
