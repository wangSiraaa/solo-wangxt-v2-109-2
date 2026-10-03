/**
 * 非破坏性片段纯逻辑测试：
 *  - 越界/重叠/非法循环拒绝（不产生静音假成功的前提）
 *  - 本地时间→原始缓冲偏移映射（含循环同一时钟闭式回绕）
 *  - 淡化曲线
 *  - v1 工程迁移只补描述、不改其他数据
 *  - 撤销/重做整体替换描述，反复操作无数值累积误差
 *  - 片段独立问题：缺失/解码失败/时长变化/未就绪互不混淆，且不抹描述
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Clip, ClipDraft, ProjectDoc, Track } from '../src/types.ts';
import {
  CLIP_EPS,
  assertValidClip,
  clipLength,
  fadeGain,
  getClipIssue,
  localToSourceOffset,
  migrateDoc,
  validateClipDraft,
  ClipValidationError,
} from '../src/lib/clip.ts';
import {
  applyEntryToClips,
  cloneClip,
  entryRemovesClip,
  type ClipHistoryEntry,
} from '../src/lib/clipHistory.ts';

function draft(over: Partial<ClipDraft> = {}): ClipDraft {
  return {
    inPoint: 0.5,
    outPoint: 2.5,
    fadeIn: { length: 0.05, curve: 'linear' },
    fadeOut: { length: 0.1, curve: 'equalPower' },
    loop: { enabled: false, inPoint: 0.5, outPoint: 2.5 },
    ...over,
  };
}

function clip(over: Partial<Clip> = {}): Clip {
  const d = draft();
  return {
    id: 'c1',
    name: '片段 1',
    trackId: 't1',
    inPoint: d.inPoint,
    outPoint: d.outPoint,
    fadeIn: d.fadeIn,
    fadeOut: d.fadeOut,
    loop: d.loop,
    sourceDuration: 4,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('片段校验：非法范围/重叠/越界必须拒绝', () => {
  it('合法草稿无问题', () => {
    assert.deepEqual(validateClipDraft(draft(), 4), []);
  });

  it('入点为负、出点越过原时长拒绝', () => {
    const issues = validateClipDraft(draft({ inPoint: -0.01, outPoint: 4.5 }), 4);
    assert.ok(issues.some((m) => m.includes('入点')));
    assert.ok(issues.some((m) => m.includes('越过原文件时长')));
  });

  it('出点不晚于入点拒绝（零/负长度）', () => {
    assert.ok(validateClipDraft(draft({ inPoint: 2, outPoint: 2 }), 4).length > 0);
    assert.ok(validateClipDraft(draft({ inPoint: 2.1, outPoint: 2 }), 4).length > 0);
  });

  it('淡入+淡出超过片段长度拒绝（不可解释的交叉淡化）', () => {
    const issues = validateClipDraft(
      draft({
        inPoint: 0,
        outPoint: 1,
        fadeIn: { length: 0.6, curve: 'linear' },
        fadeOut: { length: 0.6, curve: 'linear' },
      }),
      4,
    );
    assert.ok(issues.some((m) => m.includes('交叉淡化')));
  });

  it('淡化长度为负拒绝', () => {
    assert.throws(
      () =>
        assertValidClip(
          draft({ fadeIn: { length: -0.02, curve: 'linear' } }),
          4,
        ),
      ClipValidationError,
    );
  });

  it('循环点越过片段边界拒绝；循环体容不下淡化拒绝', () => {
    const over = validateClipDraft(
      draft({
        loop: { enabled: true, inPoint: 0.4, outPoint: 2.5 }, // 循环入点 < 片段入点
      }),
      4,
    );
    assert.ok(over.some((m) => m.includes('循环入点')));

    const tight = validateClipDraft(
      draft({
        inPoint: 0,
        outPoint: 2,
        fadeIn: { length: 0.4, curve: 'linear' },
        fadeOut: { length: 0.4, curve: 'linear' },
        loop: { enabled: true, inPoint: 0.1, outPoint: 0.5 },
      }),
      4,
    );
    assert.ok(tight.some((m) => m.includes('循环区间长度')));
  });

  it('边界恰在容差内视为合法（吸收浮点往返）', () => {
    assert.deepEqual(
      validateClipDraft(draft({ inPoint: -CLIP_EPS / 2, outPoint: 4 + CLIP_EPS / 2 }), 4),
      [],
    );
  });

  it('assertValidClip 抛出包含全部原因的错误', () => {
    try {
      assertValidClip(draft({ inPoint: -1, outPoint: 99 }), 4);
      assert.fail('应当抛出');
    } catch (err) {
      assert.ok(err instanceof ClipValidationError);
      assert.ok(err.issues.length >= 2);
    }
  });
});

describe('片段时间映射：同一时钟闭式回绕，无累积漂移', () => {
  const c = clip({
    inPoint: 1,
    outPoint: 3,
    loop: { enabled: true, inPoint: 1.5, outPoint: 2.5 },
    fadeIn: { length: 0, curve: 'linear' },
    fadeOut: { length: 0, curve: 'linear' },
  });

  it('首遍线性覆盖完整片段', () => {
    assert.ok(Math.abs(localToSourceOffset(c, 0) - 1) < 1e-12);
    assert.ok(Math.abs(localToSourceOffset(c, 0.25) - 1.25) < 1e-12);
    assert.ok(Math.abs(localToSourceOffset(c, 2 - CLIP_EPS) - (3 - CLIP_EPS)) < 1e-9);
  });

  it('首遍结束后回到循环入点；每圈严格一致', () => {
    // 本地 2 = 首遍末尾 → 循环体起点 1.5
    assert.ok(Math.abs(localToSourceOffset(c, 2) - 1.5) < 1e-12);
    // 本地 3 = 第一圈循环体结束 → 回到 1.5
    assert.ok(Math.abs(localToSourceOffset(c, 3) - 1.5) < 1e-12);
    assert.ok(Math.abs(localToSourceOffset(c, 3.5) - 2.0) < 1e-12);
    assert.ok(Math.abs(localToSourceOffset(c, 4) - 1.5) < 1e-12);
    // 模拟很多圈：闭式取模，不依赖迭代，误差不随圈数增长
    for (let k = 1; k <= 10000; k++) {
      const off = localToSourceOffset(c, 2 + k);
      assert.ok(off >= 1.5 - CLIP_EPS && off <= 2.5 + CLIP_EPS);
    }
    assert.ok(Math.abs(localToSourceOffset(c, 2 + 10000) - 1.5) < 1e-9);
  });

  it('非循环片段播到出点即停', () => {
    const n = clip({ loop: { enabled: false, inPoint: 0.5, outPoint: 2.5 } });
    assert.equal(localToSourceOffset(n, 99), 2.5);
  });
});

describe('淡化曲线', () => {
  it('线性端点 0→1；等功率端点与中点', () => {
    assert.equal(fadeGain('linear', 0), 0);
    assert.equal(fadeGain('linear', 1), 1);
    assert.equal(fadeGain('equalPower', 0), 0);
    assert.equal(fadeGain('equalPower', 1), 1);
    assert.ok(Math.abs(fadeGain('equalPower', 0.5) - Math.SQRT1_2) < 1e-9);
  });
  it('片段长度正确', () => {
    assert.equal(clipLength(clip()), 2);
  });
});

describe('片段独立问题（不抹编辑历史）', () => {
  const c = clip({ sourceDuration: 4 });
  const track = (over: Partial<Track>): Track => ({
    id: 't1',
    name: 't',
    sourceType: 'file',
    blobKey: 'b1',
    loop: false,
    muted: false,
    solo: false,
    gain: 1,
    channel: 0,
    color: '#fff',
    position: { x: 0, y: 0, z: 0 },
    status: 'ready',
    duration: 4,
    clips: [c],
    activeClipId: 'c1',
    ...over,
  });

  it('就绪轨无问题', () => {
    assert.equal(getClipIssue(track({}), c, true), null);
  });

  it('未解锁/未解码 → not-ready（描述仍可审阅）', () => {
    assert.equal(getClipIssue(track({ status: 'pending', duration: undefined }), c, true)?.kind, 'not-ready');
    assert.equal(getClipIssue(track({}), c, false)?.kind, 'not-ready');
  });

  it('解码失败与 Blob 缺失给出不同独立原因', () => {
    const dec = getClipIssue(track({ status: 'decode-error', errorMessage: 'EncodingError' }), c, true);
    assert.equal(dec?.kind, 'decode-error');
    const miss = getClipIssue(
      track({ status: 'decode-error', errorMessage: '本地音频 Blob 缺失' }),
      c,
      true,
    );
    assert.equal(miss?.kind, 'source-missing');
  });

  it('原文件时长变化 → duration-changed（边界需审阅，片段保留）', () => {
    const issue = getClipIssue(track({ duration: 3.2 }), c, true);
    assert.equal(issue?.kind, 'duration-changed');
    // 即使状态仍是 ready，问题由时长独立判定
    assert.ok(issue!.message.includes('3.200'));
  });
});

describe('工程迁移：只补片段描述字段', () => {
  it('v1 工程迁移为 v2，tracks 其余字段与 blobs 无涉', () => {
    const v1 = {
      version: 1 as const,
      tracks: [
        {
          id: 't1',
          name: 'a',
          sourceType: 'tone' as const,
          loop: true,
          muted: false,
          solo: false,
          gain: 1,
          channel: 0,
          color: '#fff',
          position: { x: 1, y: 0, z: 0 },
          status: 'ready' as const,
        },
      ],
      listener: { position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, earHeight: 0 },
      spatial: {
        distanceModel: 'inverse' as const,
        refDistance: 1,
        rolloffFactor: 1,
        maxDistance: 30,
        positionTimeConstant: 0.06,
        hrtfIR: 'none' as const,
      },
      busGain: 1,
      masterGain: 1,
      savedAt: 0,
    };
    const v2 = migrateDoc(v1 as unknown as ProjectDoc);
    assert.equal(v2.version, 2);
    assert.deepEqual(v2.tracks[0].clips, []);
    assert.equal(v2.tracks[0].activeClipId, null);
    assert.equal(v2.tracks[0].name, 'a'); // 原字段未动
  });
});

describe('撤销/重做：整体替换描述，无累积误差，绝不复制音频', () => {
  const c0 = clip({ inPoint: 1 / 3, outPoint: 2 / 3, fadeIn: { length: 0.01, curve: 'linear' } });
  const c1 = {
    ...c0,
    inPoint: 0.4,
    outPoint: 0.9,
    fadeIn: { length: 0.02, curve: 'equalPower' as const },
    version: 2,
  };
  const entry: ClipHistoryEntry = { type: 'update', trackId: 't1', before: cloneClip(c0), after: cloneClip(c1) };

  it('撤销精确恢复旧边界/淡化；重做精确恢复新值', () => {
    let clips: Clip[] = [cloneClip(c1)];
    clips = applyEntryToClips(clips, entry, 'undo');
    assert.ok(Math.abs(clips[0].inPoint - 1 / 3) < 1e-15);
    assert.ok(Math.abs(clips[0].outPoint - 2 / 3) < 1e-15);
    assert.equal(clips[0].fadeIn.length, 0.01);
    assert.equal(clips[0].fadeIn.curve, 'linear');
    assert.equal(clips[0].version, 1);

    clips = applyEntryToClips(clips, entry, 'redo');
    assert.ok(Math.abs(clips[0].inPoint - 0.4) < 1e-15);
    assert.equal(clips[0].fadeIn.curve, 'equalPower');
    assert.equal(clips[0].version, 2);
  });

  it('重复撤销/重做 200 轮后数值与首轮完全一致（无累积误差）', () => {
    let clips: Clip[] = [cloneClip(c1)];
    for (let i = 0; i < 200; i++) {
      clips = applyEntryToClips(clips, entry, 'undo');
      clips = applyEntryToClips(clips, entry, 'redo');
    }
    const c = clips[0];
    assert.equal(c.inPoint, 0.4);
    assert.equal(c.outPoint, 0.9);
    assert.equal(c.fadeIn.length, 0.02);
    // 撤销一次后的最终旧值也必须与最初快照逐字段相等
    clips = applyEntryToClips(clips, entry, 'undo');
    assert.deepEqual(clips[0], entry.before);
  });

  it('create/delete 的撤销与重做增删的是同一 id；活动片段被移除时给出 id', () => {
    const add: ClipHistoryEntry = { type: 'create', trackId: 't1', clip: cloneClip(c0) };
    assert.deepEqual(applyEntryToClips([], add, 'redo'), [c0]);
    assert.deepEqual(applyEntryToClips([c0], add, 'undo'), []);
    assert.equal(entryRemovesClip(add, 'undo'), c0.id);
    assert.equal(entryRemovesClip(add, 'redo'), null);

    const del: ClipHistoryEntry = { type: 'delete', trackId: 't1', clip: cloneClip(c0) };
    assert.deepEqual(applyEntryToClips([], del, 'undo'), [c0]);
    assert.deepEqual(applyEntryToClips([c0], del, 'redo'), []);
    assert.equal(entryRemovesClip(del, 'redo'), c0.id);
  });
});
