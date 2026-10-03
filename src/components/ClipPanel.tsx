import { useEffect, useMemo, useState } from 'react';
import type { Clip, FadeShape, Track } from '../types';
import { engine } from '../lib/engineInstance';
import type { ClipDraft, WorkbenchApi } from '../state/useWorkbench';
import { clipRegionLength } from '../lib/clipEdit';

interface Props {
  api: WorkbenchApi;
}

function fmt(t: number | null | undefined): string {
  if (t == null || !isFinite(t)) return '--:--.--';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

const ISSUE_LABEL: Record<string, string> = {
  'missing-source': '引用声轨已删除',
  'source-missing-blob': '本地原文件缺失',
  'source-decode-error': '原文件解码失败',
  'source-changed': '原文件时长已变化',
  'out-of-range': '片段越界',
};

/** 片段面板：只展示/编辑“引用 + 边界 + 淡化 + 循环 + 版本”，不触碰原始音频 */
export function ClipPanel({ api }: Props) {
  const { doc, clipApi, selectedClipId } = api;
  const clip = doc.clips.find((c) => c.id === selectedClipId) ?? null;
  const track = clip ? doc.tracks.find((t) => t.id === clip.trackId) : null;

  return (
    <div className="panel clip-panel">
      <div className="panel-title">
        非破坏性片段
        <span className="muted small" style={{ marginLeft: 6 }}>
          只引用声轨与原始时间范围，不改写 Blob
        </span>
      </div>

      <div className="clip-toolbar">
        <button className="btn small" onClick={() => void clipApi.playAllClips()} disabled={doc.clips.length === 0}>
          ▶ 全部片段（同一时钟）
        </button>
        <button className="btn small" onClick={clipApi.stopAllClips} disabled={doc.clips.length === 0}>
          ⏹
        </button>
        <button className="btn small ghost" onClick={clipApi.undoClip} disabled={!clipApi.canUndoClip} title="撤销：只恢复编辑描述">
          ↶ 撤销
        </button>
        <button className="btn small ghost" onClick={clipApi.redoClip} disabled={!clipApi.canRedoClip} title="恢复">
          ↷ 恢复
        </button>
      </div>

      {doc.clips.length === 0 && (
        <p className="muted small">
          还没有片段。在任意声轨上点「✀ 建片段」，反复截取不同入点/出点、淡化与循环区间试听。
        </p>
      )}

      <div className="clip-list">
        {doc.clips.map((c) => {
          const tr = doc.tracks.find((t) => t.id === c.trackId);
          const issue = clipApi.getClipIssue(c);
          const playing = clipApi.playingClipIds.has(c.id);
          const pending = clipApi.pendingClipIds.has(c.id);
          const err = clipApi.clipErrors[c.id];
          const selected = c.id === selectedClipId;
          return (
            <div
              key={c.id}
              className={`clip-item ${selected ? 'selected' : ''} ${issue && issue.issue !== 'source-changed' ? 'blocked' : ''}`}
            >
              <div className="clip-item-head">
                <span className="track-color" style={{ background: c.color }} />
                <button className="clip-name" onClick={() => clipApi.selectClip(selected ? null : c.id)}>
                  {c.name}
                </button>
                <span className="clip-rev" title="编辑描述版本（每次成功提交 +1）">v{c.revision}</span>
              </div>
              <div className="clip-item-sub muted small">
                引用：{tr ? tr.name : '（声轨已删除）'} · {fmt(c.sourceStart)}–{fmt(c.sourceEnd)}（
                {fmt(clipRegionLength(c))}）
                {c.fadeIn.duration > 0 && <> · 淡入 {fmt(c.fadeIn.duration)}</>}
                {c.fadeOut.duration > 0 && <> · 淡出 {fmt(c.fadeOut.duration)}</>}
                {c.loop.enabled && (
                  <>
                    {' '}
                    · 循环回跳 {fmt(c.loop.start)}
                    {isFinite(c.loop.count) ? ` ×${c.loop.count}` : ' ∞'}
                  </>
                )}
              </div>
              <div className="clip-item-actions">
                <button className="btn mini" onClick={() => void clipApi.toggleClip(c.id)}>
                  {playing ? '⏸' : '▶'}
                </button>
                <button className="btn mini" onClick={() => clipApi.stopClip(c.id)}>
                  ⏹
                </button>
                <button
                  className="btn mini ghost danger"
                  onClick={() => {
                    if (confirm(`删除片段「${c.name}」？只删除编辑描述，原始音频不受影响。`)) {
                      clipApi.removeClip(c.id);
                    }
                  }}
                >
                  删片段
                </button>
                {pending && <span className="clip-pending" title="编辑将在下一循环/结束安全边界生效">将在安全边界生效…</span>}
              </div>
              {issue && (
                <div className={`clip-issue ${issue.issue === 'source-changed' ? 'warn' : 'error'}`} title={issue.detail}>
                  ⚠ {ISSUE_LABEL[issue.issue]}：{issue.detail}
                </div>
              )}
              {err && <div className="clip-issue error">⛔ {err}</div>}
              <ClipProgressBar clip={c} api={api} active={playing} />
            </div>
          );
        })}
      </div>

      {clip && track && <ClipEditor clip={clip} track={track} api={api} />}
      {clip && !track && (
        <div className="clip-editor blocked">
          片段引用的声轨已删除。编辑历史完整保留，重新导入同名/同源声轨前不可试听。
        </div>
      )}
    </div>
  );
}

function ClipProgressBar({ clip, api, active }: { clip: Clip; api: WorkbenchApi; active: boolean }) {
  const [p, setP] = useState(0);
  const life = clipRegionLength(clip);
  useEffect(() => {
    if (!active) {
      setP(engine.getClipProgress(clip.id));
      return;
    }
    let raf = 0;
    const tick = () => {
      setP(engine.getClipProgress(clip.id));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, clip.id]);
  return (
    <div
      className="clip-progress"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        void api.clipApi.seekClip(clip.id, ratio * life);
      }}
      title="片段时间线（点击跳转）"
    >
      <div className="clip-progress-fill" style={{ width: `${life ? Math.min(100, (p / life) * 100) : 0}%` }} />
      <span className="clip-time">
        {fmt(p)} / {fmt(life)}
      </span>
    </div>
  );
}

/** 可审阅时间区域：源全长轨道 + 入点/出点/淡化/循环手柄；越界松手时提交被拒绝 */
function ClipEditor({ clip, track, api }: { clip: Clip; track: Track; api: WorkbenchApi }) {
  const duration = engine.getDuration(track.id) ?? track.duration ?? clip.sourceDuration;
  const saved = useMemo<ClipDraft>(
    () => ({
      sourceStart: clip.sourceStart,
      sourceEnd: clip.sourceEnd,
      fadeInDuration: clip.fadeIn.duration,
      fadeInShape: clip.fadeIn.shape,
      fadeOutDuration: clip.fadeOut.duration,
      fadeOutShape: clip.fadeOut.shape,
      loopEnabled: clip.loop.enabled,
      loopStart: clip.loop.start,
      loopCount: clip.loop.count,
    }),
    [clip],
  );
  const liveDraft = api.clipApi.getDraft(clip.id) ?? saved;
  const [rejectMsg, setRejectMsg] = useState<string[] | null>(null);

  // 切换选中片段时清掉上一条拒绝信息
  useEffect(() => setRejectMsg(null), [clip.id]);

  const update = (patch: Partial<ClipDraft>, commit = false) => {
    api.clipApi.draftClip(clip.id, patch);
    if (commit) submit(patch);
  };

  const submit = (override?: Partial<ClipDraft>) => {
    const d = { ...(api.clipApi.getDraft(clip.id) ?? liveDraft), ...override };
    const res = api.clipApi.commitClipEdit(clip.id, d);
    if (!res.ok) {
      setRejectMsg(res.reasons);
      api.clipApi.revertClipDraft(clip.id);
    } else {
      setRejectMsg(null);
    }
  };

  return (
    <div className="clip-editor">
      <div className="clip-editor-title">
        时间区域审阅 · {clip.name}
        <span className="muted small">（源全长 {fmt(duration)}s）</span>
      </div>

      <div className="clip-region">
        <div className="clip-region-track">
          {/* 选中区域（引用区间，不含任何音频数据） */}
          <div
            className="clip-region-selected-real"
            style={{
              left: `${(liveDraft.sourceStart / duration) * 100}%`,
              width: `${((liveDraft.sourceEnd - liveDraft.sourceStart) / duration) * 100}%`,
            }}
          />
          {/* 淡入/淡出覆盖层 */}
          <div
            className="clip-fade-in"
            style={{
              left: `${(liveDraft.sourceStart / duration) * 100}%`,
              width: `${(liveDraft.fadeInDuration / duration) * 100}%`,
            }}
          />
          <div
            className="clip-fade-out"
            style={{
              left: `${((liveDraft.sourceEnd - liveDraft.fadeOutDuration) / duration) * 100}%`,
              width: `${(liveDraft.fadeOutDuration / duration) * 100}%`,
            }}
          />
          {/* 循环回跳点 */}
          {liveDraft.loopEnabled && (
            <div className="clip-loop-mark" style={{ left: `${(liveDraft.loopStart / duration) * 100}%` }} title={`循环回跳 ${fmt(liveDraft.loopStart)}s`} />
          )}
          <Handle
            label="入"
            positionPct={(liveDraft.sourceStart / duration) * 100}
            onDrag={(dxRatio) => update({ sourceStart: clampTime(dxToTime(liveDraft.sourceStart, dxRatio, duration)) })}
            onCommit={(dxRatio) => submit({ sourceStart: clampTime(dxToTime(liveDraft.sourceStart, dxRatio, duration)) })}
          />
          <Handle
            label="出"
            positionPct={(liveDraft.sourceEnd / duration) * 100}
            onDrag={(dxRatio) => update({ sourceEnd: clampTime(dxToTime(liveDraft.sourceEnd, dxRatio, duration)) })}
            onCommit={(dxRatio) => submit({ sourceEnd: clampTime(dxToTime(liveDraft.sourceEnd, dxRatio, duration)) })}
          />
          <Handle
            label="淡入"
            positionPct={((liveDraft.sourceStart + liveDraft.fadeInDuration) / duration) * 100}
            onDrag={(dxRatio) => update({ fadeInDuration: Math.max(0, dxToTime(liveDraft.fadeInDuration, dxRatio, duration)) })}
            onCommit={(dxRatio) => submit({ fadeInDuration: Math.max(0, dxToTime(liveDraft.fadeInDuration, dxRatio, duration)) })}
          />
          <Handle
            label="淡出"
            positionPct={((liveDraft.sourceEnd - liveDraft.fadeOutDuration) / duration) * 100}
            onDrag={(dxRatio) => update({ fadeOutDuration: Math.max(0, dxToTime(liveDraft.fadeOutDuration, dxRatio, duration)) })}
            onCommit={(dxRatio) => submit({ fadeOutDuration: Math.max(0, dxToTime(liveDraft.fadeOutDuration, dxRatio, duration)) })}
          />
          {liveDraft.loopEnabled && (
            <Handle
              label="循环"
              positionPct={(liveDraft.loopStart / duration) * 100}
              onDrag={(dxRatio) => update({ loopStart: clampTime(dxToTime(liveDraft.loopStart, dxRatio, duration)) })}
              onCommit={(dxRatio) => submit({ loopStart: clampTime(dxToTime(liveDraft.loopStart, dxRatio, duration)) })}
            />
          )}
        </div>
        <div className="clip-region-scale muted small">
          <span>0.00</span>
          <span>{fmt(duration / 2)}</span>
          <span>{fmt(duration)}</span>
        </div>
      </div>

      <div className="clip-fields">
        <NumField label="入点 s" value={liveDraft.sourceStart} onDraft={(v) => update({ sourceStart: v })} onCommit={(v) => submit({ sourceStart: v })} />
        <NumField label="出点 s" value={liveDraft.sourceEnd} onDraft={(v) => update({ sourceEnd: v })} onCommit={(v) => submit({ sourceEnd: v })} />
        <NumField label="淡入 s" value={liveDraft.fadeInDuration} step={0.01} min={0} onDraft={(v) => update({ fadeInDuration: v })} onCommit={(v) => submit({ fadeInDuration: v })} />
        <ShapeField value={liveDraft.fadeInShape} onChange={(shape) => submit({ fadeInShape: shape })} />
        <NumField label="淡出 s" value={liveDraft.fadeOutDuration} step={0.01} min={0} onDraft={(v) => update({ fadeOutDuration: v })} onCommit={(v) => submit({ fadeOutDuration: v })} />
        <ShapeField value={liveDraft.fadeOutShape} onChange={(shape) => submit({ fadeOutShape: shape })} />
      </div>

      <div className="clip-loop-row">
        <label className="loop-toggle">
          <input
            type="checkbox"
            checked={liveDraft.loopEnabled}
            onChange={(e) => submit({ loopEnabled: e.target.checked })}
          />
          循环区间
        </label>
        {liveDraft.loopEnabled && (
          <>
            <NumField label="回跳点 s" value={liveDraft.loopStart} onDraft={(v) => update({ loopStart: v })} onCommit={(v) => submit({ loopStart: v })} />
            <label className="num-field">
              <span>次数</span>
              <input
                type="number"
                min={1}
                step={1}
                value={isFinite(liveDraft.loopCount) ? liveDraft.loopCount : 0}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  submit({ loopCount: n <= 0 ? Number.POSITIVE_INFINITY : Math.max(1, Math.round(n)) });
                }}
              />
            </label>
            <span className="muted small">（0 = 持续循环；持续循环不可设淡出）</span>
          </>
        )}
      </div>

      {rejectMsg && (
        <div className="clip-reject">
          提交被拒绝，原片段与原始 Blob 保持不变：
          {rejectMsg.map((r, i) => (
            <div key={i}>• {r}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function dxToTime(base: number, dxRatio: number, duration: number): number {
  return base + dxRatio * duration;
}

function clampTime(t: number): number {
  return Math.max(0, t);
}

/** 可拖拽手柄：拖动只改草稿，松手才提交（越界则被拒绝并回弹） */
function Handle({
  label,
  positionPct,
  onDrag,
  onCommit,
}: {
  label: string;
  positionPct: number;
  onDrag: (dxRatio: number) => void;
  onCommit: (dxRatio: number) => void;
}) {
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget.parentElement!;
    const rect = target.getBoundingClientRect();
    const startX = e.clientX;
    let dx = 0;
    const move = (ev: PointerEvent) => {
      dx = (ev.clientX - startX) / rect.width;
      onDrag(dx);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onCommit(dx);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className="clip-handle"
      onPointerDown={start}
      style={{ left: `${Math.min(100, Math.max(0, positionPct))}%` }}
      title={label}
    >
      <span>{label}</span>
    </div>
  );
}

function NumField({
  label,
  value,
  step = 0.01,
  min,
  onDraft,
  onCommit,
}: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  onDraft: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  return (
    <label className="num-field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        value={Number.isFinite(value) ? Number(value.toFixed(4)) : 0}
        onChange={(e) => onDraft(Number(e.target.value))}
        onBlur={(e) => onCommit(Number(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit(Number((e.target as HTMLInputElement).value));
        }}
      />
    </label>
  );
}

function ShapeField({ value, onChange }: { value: FadeShape; onChange: (s: FadeShape) => void }) {
  return (
    <label className="num-field">
      <span>曲线</span>
      <select value={value} onChange={(e) => onChange(e.target.value as FadeShape)}>
        <option value="linear">线性</option>
        <option value="equalPower">等功率</option>
        <option value="exponential">指数</option>
      </select>
    </label>
  );
}
