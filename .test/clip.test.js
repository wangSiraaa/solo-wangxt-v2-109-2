// test/clip.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// src/lib/clip.ts
var CLIP_EPS = 1 / 24e3;
var ClipValidationError = class extends Error {
  issues;
  constructor(issues) {
    super(issues.join("\uFF1B"));
    this.name = "ClipValidationError";
    this.issues = issues;
  }
};
var isNum = (n) => typeof n === "number" && Number.isFinite(n);
function validateClipDraft(draft2, duration) {
  const issues = [];
  const { inPoint, outPoint, fadeIn, fadeOut, loop } = draft2;
  if (!isNum(inPoint) || !isNum(outPoint)) {
    issues.push("\u5165\u70B9/\u51FA\u70B9\u5FC5\u987B\u662F\u6709\u9650\u6570\u503C");
    return issues;
  }
  if (inPoint < -CLIP_EPS) issues.push(`\u5165\u70B9 ${fmt(inPoint)}s \u8D8A\u754C\uFF08\u4E0D\u80FD\u5C0F\u4E8E 0\uFF09`);
  if (duration != null && outPoint > duration + CLIP_EPS) {
    issues.push(`\u51FA\u70B9 ${fmt(outPoint)}s \u8D8A\u8FC7\u539F\u6587\u4EF6\u65F6\u957F ${fmt(duration)}s`);
  }
  if (outPoint <= inPoint + CLIP_EPS) issues.push("\u51FA\u70B9\u5FC5\u987B\u4E25\u683C\u665A\u4E8E\u5165\u70B9");
  const clipLen = outPoint - inPoint;
  const checkFade = (f, label) => {
    if (!isNum(f.length)) {
      issues.push(`${label}\u957F\u5EA6\u5FC5\u987B\u662F\u6709\u9650\u6570\u503C`);
      return;
    }
    if (f.length < -CLIP_EPS) issues.push(`${label}\u957F\u5EA6 ${fmt(f.length)}s \u4E0D\u80FD\u4E3A\u8D1F\uFF08\u8D8A\u754C\uFF09`);
    if (f.curve !== "linear" && f.curve !== "equalPower") {
      issues.push(`${label}\u66F2\u7EBF\u7C7B\u578B\u975E\u6CD5`);
    }
  };
  checkFade(fadeIn, "\u6DE1\u5165");
  checkFade(fadeOut, "\u6DE1\u51FA");
  const fi = Math.max(0, fadeIn.length);
  const fo = Math.max(0, fadeOut.length);
  if (fi + fo > clipLen + CLIP_EPS) {
    issues.push(
      `\u6DE1\u5165 ${fmt(fi)}s + \u6DE1\u51FA ${fmt(fo)}s \u8D85\u8FC7\u7247\u6BB5\u957F\u5EA6 ${fmt(clipLen)}s\uFF0C\u91CD\u53E0\u4F1A\u4EA7\u751F\u4E0D\u53EF\u89E3\u91CA\u7684\u4EA4\u53C9\u6DE1\u5316`
    );
  }
  if (loop.enabled) {
    if (!isNum(loop.inPoint) || !isNum(loop.outPoint)) {
      issues.push("\u5FAA\u73AF\u5165/\u51FA\u70B9\u5FC5\u987B\u662F\u6709\u9650\u6570\u503C");
    } else {
      if (loop.inPoint < inPoint - CLIP_EPS) issues.push("\u5FAA\u73AF\u5165\u70B9\u8D8A\u8FC7\u7247\u6BB5\u5165\u70B9\uFF08\u8D8A\u754C\uFF09");
      if (loop.outPoint > outPoint + CLIP_EPS) issues.push("\u5FAA\u73AF\u51FA\u70B9\u8D8A\u8FC7\u7247\u6BB5\u51FA\u70B9\uFF08\u8D8A\u754C\uFF09");
      if (loop.outPoint <= loop.inPoint + CLIP_EPS) issues.push("\u5FAA\u73AF\u533A\u95F4\u5FC5\u987B\u4E3A\u6B63\u957F\u5EA6");
      const loopLen = loop.outPoint - loop.inPoint;
      if (fi + fo > loopLen + CLIP_EPS) {
        issues.push(
          `\u5FAA\u73AF\u533A\u95F4\u957F\u5EA6 ${fmt(loopLen)}s \u5BB9\u4E0D\u4E0B\u6DE1\u5165+\u6DE1\u51FA ${fmt(fi + fo)}s\uFF08\u91CD\u53E0\u4F1A\u4EA7\u751F\u4E0D\u53EF\u89E3\u91CA\u7684\u4EA4\u53C9\u6DE1\u5316\uFF09`
        );
      }
    }
  }
  return issues;
}
function assertValidClip(draft2, duration) {
  const issues = validateClipDraft(draft2, duration);
  if (issues.length) throw new ClipValidationError(issues);
}
function clipLength(clip2) {
  return clip2.outPoint - clip2.inPoint;
}
function localToSourceOffset(clip2, local) {
  const len = clipLength(clip2);
  if (!clip2.loop.enabled) {
    return clip2.inPoint + Math.min(Math.max(0, local), len);
  }
  if (local < len) return clip2.inPoint + Math.max(0, local);
  const loopLen = Math.max(CLIP_EPS, clip2.loop.outPoint - clip2.loop.inPoint);
  const intoLoop = local - len;
  const wrapped = (intoLoop % loopLen + loopLen) % loopLen;
  return clip2.loop.inPoint + wrapped;
}
function fadeGain(curve, p) {
  const x = Math.min(1, Math.max(0, p));
  if (curve === "equalPower") {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return Math.cos((1 - x) * Math.PI / 2);
  }
  return x;
}
function fmt(t) {
  return (Math.round(t * 1e3) / 1e3).toString();
}
function getClipIssue(track, clip2, unlocked) {
  const actual = track.duration ?? null;
  if (clip2.sourceDuration != null && actual != null && Math.abs(actual - clip2.sourceDuration) > CLIP_EPS) {
    return {
      kind: "duration-changed",
      message: `\u539F\u6587\u4EF6\u65F6\u957F\u5DF2\u53D8\u5316\uFF1A\u8BB0\u5F55 ${clip2.sourceDuration.toFixed(3)}s\uFF0C\u5F53\u524D ${actual.toFixed(
        3
      )}s\u3002\u7247\u6BB5\u5B9A\u4E49\u4FDD\u7559\uFF0C\u8BF7\u91CD\u65B0\u5BA1\u9605\u8FB9\u754C\u540E\u518D\u8BD5\u542C\u3002`
    };
  }
  if (actual != null && clip2.outPoint > actual + CLIP_EPS) {
    return {
      kind: "duration-changed",
      message: `\u7247\u6BB5\u51FA\u70B9 ${fmt(clip2.outPoint)}s \u5DF2\u8D8A\u8FC7\u5F53\u524D\u539F\u6587\u4EF6\u65F6\u957F ${fmt(
        actual
      )}s\uFF0C\u9700\u91CD\u65B0\u5BA1\u9605\u3002`
    };
  }
  if (track.status === "decode-error") {
    if (track.errorMessage?.includes("Blob \u7F3A\u5931")) {
      return {
        kind: "source-missing",
        message: `\u539F\u59CB\u672C\u5730\u6587\u4EF6\u5DF2\u4ECE IndexedDB \u4E22\u5931\uFF08${track.errorMessage}\uFF09\u3002\u7247\u6BB5\u5B9A\u4E49\u4E0E\u7F16\u8F91\u5386\u53F2\u4FDD\u7559\uFF0C\u91CD\u65B0\u5BFC\u5165\u540C\u540D\u6587\u4EF6\u540E\u53EF\u6062\u590D\u8BD5\u542C\u3002`
      };
    }
    return {
      kind: "decode-error",
      message: `\u539F\u59CB\u6587\u4EF6\u89E3\u7801\u5931\u8D25\uFF1A${track.errorMessage ?? "\u672A\u77E5\u539F\u56E0"}\u3002\u7247\u6BB5\u5B9A\u4E49\u4E0E\u7F16\u8F91\u5386\u53F2\u4FDD\u7559\u3002`
    };
  }
  if (!unlocked || track.status === "pending" || track.status === "loading" || actual == null) {
    return { kind: "not-ready", message: "\u539F\u59CB\u97F3\u9891\u5C1A\u672A\u5C31\u7EEA\uFF0C\u89E3\u9501\u5E76\u89E3\u7801\u540E\u53EF\u8BD5\u542C\uFF08\u63CF\u8FF0\u4ECD\u53EF\u5BA1\u9605/\u7F16\u8F91\uFF09\u3002" };
  }
  return null;
}
function migrateDoc(raw) {
  if (raw.version === 2) return raw;
  if (raw.version !== 1) {
    throw new Error(`\u4E0D\u652F\u6301\u7684\u5DE5\u7A0B\u7248\u672C\uFF1A${raw.version ?? "\u672A\u77E5"}`);
  }
  const tracks = raw.tracks.map((t) => ({
    ...t,
    clips: Array.isArray(t.clips) ? t.clips : [],
    activeClipId: t.activeClipId ?? null
  }));
  return { ...raw, version: 2, tracks };
}

// src/lib/clipHistory.ts
function cloneClip(clip2) {
  return {
    ...clip2,
    fadeIn: { ...clip2.fadeIn },
    fadeOut: { ...clip2.fadeOut },
    loop: { ...clip2.loop }
  };
}
function applyEntryToClips(clips, entry, dir) {
  if (entry.type === "create") {
    if (dir === "undo") return clips.filter((c) => c.id !== entry.clip.id);
    return [...clips, cloneClip(entry.clip)];
  }
  if (entry.type === "delete") {
    if (dir === "redo") return clips.filter((c) => c.id !== entry.clip.id);
    return [...clips, cloneClip(entry.clip)];
  }
  const target = dir === "undo" ? entry.before : entry.after;
  return clips.map((c) => c.id === target.id ? cloneClip(target) : c);
}
function entryRemovesClip(entry, dir) {
  const removingCreate = entry.type === "create" && dir === "undo";
  const removingDelete = entry.type === "delete" && dir === "redo";
  return removingCreate || removingDelete ? entry.clip.id : null;
}

// test/clip.test.ts
function draft(over = {}) {
  return {
    inPoint: 0.5,
    outPoint: 2.5,
    fadeIn: { length: 0.05, curve: "linear" },
    fadeOut: { length: 0.1, curve: "equalPower" },
    loop: { enabled: false, inPoint: 0.5, outPoint: 2.5 },
    ...over
  };
}
function clip(over = {}) {
  const d = draft();
  return {
    id: "c1",
    name: "\u7247\u6BB5 1",
    trackId: "t1",
    inPoint: d.inPoint,
    outPoint: d.outPoint,
    fadeIn: d.fadeIn,
    fadeOut: d.fadeOut,
    loop: d.loop,
    sourceDuration: 4,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over
  };
}
describe("\u7247\u6BB5\u6821\u9A8C\uFF1A\u975E\u6CD5\u8303\u56F4/\u91CD\u53E0/\u8D8A\u754C\u5FC5\u987B\u62D2\u7EDD", () => {
  it("\u5408\u6CD5\u8349\u7A3F\u65E0\u95EE\u9898", () => {
    assert.deepEqual(validateClipDraft(draft(), 4), []);
  });
  it("\u5165\u70B9\u4E3A\u8D1F\u3001\u51FA\u70B9\u8D8A\u8FC7\u539F\u65F6\u957F\u62D2\u7EDD", () => {
    const issues = validateClipDraft(draft({ inPoint: -0.01, outPoint: 4.5 }), 4);
    assert.ok(issues.some((m) => m.includes("\u5165\u70B9")));
    assert.ok(issues.some((m) => m.includes("\u8D8A\u8FC7\u539F\u6587\u4EF6\u65F6\u957F")));
  });
  it("\u51FA\u70B9\u4E0D\u665A\u4E8E\u5165\u70B9\u62D2\u7EDD\uFF08\u96F6/\u8D1F\u957F\u5EA6\uFF09", () => {
    assert.ok(validateClipDraft(draft({ inPoint: 2, outPoint: 2 }), 4).length > 0);
    assert.ok(validateClipDraft(draft({ inPoint: 2.1, outPoint: 2 }), 4).length > 0);
  });
  it("\u6DE1\u5165+\u6DE1\u51FA\u8D85\u8FC7\u7247\u6BB5\u957F\u5EA6\u62D2\u7EDD\uFF08\u4E0D\u53EF\u89E3\u91CA\u7684\u4EA4\u53C9\u6DE1\u5316\uFF09", () => {
    const issues = validateClipDraft(
      draft({
        inPoint: 0,
        outPoint: 1,
        fadeIn: { length: 0.6, curve: "linear" },
        fadeOut: { length: 0.6, curve: "linear" }
      }),
      4
    );
    assert.ok(issues.some((m) => m.includes("\u4EA4\u53C9\u6DE1\u5316")));
  });
  it("\u6DE1\u5316\u957F\u5EA6\u4E3A\u8D1F\u62D2\u7EDD", () => {
    assert.throws(
      () => assertValidClip(
        draft({ fadeIn: { length: -0.02, curve: "linear" } }),
        4
      ),
      ClipValidationError
    );
  });
  it("\u5FAA\u73AF\u70B9\u8D8A\u8FC7\u7247\u6BB5\u8FB9\u754C\u62D2\u7EDD\uFF1B\u5FAA\u73AF\u4F53\u5BB9\u4E0D\u4E0B\u6DE1\u5316\u62D2\u7EDD", () => {
    const over = validateClipDraft(
      draft({
        loop: { enabled: true, inPoint: 0.4, outPoint: 2.5 }
        // 循环入点 < 片段入点
      }),
      4
    );
    assert.ok(over.some((m) => m.includes("\u5FAA\u73AF\u5165\u70B9")));
    const tight = validateClipDraft(
      draft({
        inPoint: 0,
        outPoint: 2,
        fadeIn: { length: 0.4, curve: "linear" },
        fadeOut: { length: 0.4, curve: "linear" },
        loop: { enabled: true, inPoint: 0.1, outPoint: 0.5 }
      }),
      4
    );
    assert.ok(tight.some((m) => m.includes("\u5FAA\u73AF\u533A\u95F4\u957F\u5EA6")));
  });
  it("\u8FB9\u754C\u6070\u5728\u5BB9\u5DEE\u5185\u89C6\u4E3A\u5408\u6CD5\uFF08\u5438\u6536\u6D6E\u70B9\u5F80\u8FD4\uFF09", () => {
    assert.deepEqual(
      validateClipDraft(draft({ inPoint: -CLIP_EPS / 2, outPoint: 4 + CLIP_EPS / 2 }), 4),
      []
    );
  });
  it("assertValidClip \u629B\u51FA\u5305\u542B\u5168\u90E8\u539F\u56E0\u7684\u9519\u8BEF", () => {
    try {
      assertValidClip(draft({ inPoint: -1, outPoint: 99 }), 4);
      assert.fail("\u5E94\u5F53\u629B\u51FA");
    } catch (err) {
      assert.ok(err instanceof ClipValidationError);
      assert.ok(err.issues.length >= 2);
    }
  });
});
describe("\u7247\u6BB5\u65F6\u95F4\u6620\u5C04\uFF1A\u540C\u4E00\u65F6\u949F\u95ED\u5F0F\u56DE\u7ED5\uFF0C\u65E0\u7D2F\u79EF\u6F02\u79FB", () => {
  const c = clip({
    inPoint: 1,
    outPoint: 3,
    loop: { enabled: true, inPoint: 1.5, outPoint: 2.5 },
    fadeIn: { length: 0, curve: "linear" },
    fadeOut: { length: 0, curve: "linear" }
  });
  it("\u9996\u904D\u7EBF\u6027\u8986\u76D6\u5B8C\u6574\u7247\u6BB5", () => {
    assert.ok(Math.abs(localToSourceOffset(c, 0) - 1) < 1e-12);
    assert.ok(Math.abs(localToSourceOffset(c, 0.25) - 1.25) < 1e-12);
    assert.ok(Math.abs(localToSourceOffset(c, 2 - CLIP_EPS) - (3 - CLIP_EPS)) < 1e-9);
  });
  it("\u9996\u904D\u7ED3\u675F\u540E\u56DE\u5230\u5FAA\u73AF\u5165\u70B9\uFF1B\u6BCF\u5708\u4E25\u683C\u4E00\u81F4", () => {
    assert.ok(Math.abs(localToSourceOffset(c, 2) - 1.5) < 1e-12);
    assert.ok(Math.abs(localToSourceOffset(c, 3) - 1.5) < 1e-12);
    assert.ok(Math.abs(localToSourceOffset(c, 3.5) - 2) < 1e-12);
    assert.ok(Math.abs(localToSourceOffset(c, 4) - 1.5) < 1e-12);
    for (let k = 1; k <= 1e4; k++) {
      const off = localToSourceOffset(c, 2 + k);
      assert.ok(off >= 1.5 - CLIP_EPS && off <= 2.5 + CLIP_EPS);
    }
    assert.ok(Math.abs(localToSourceOffset(c, 2 + 1e4) - 1.5) < 1e-9);
  });
  it("\u975E\u5FAA\u73AF\u7247\u6BB5\u64AD\u5230\u51FA\u70B9\u5373\u505C", () => {
    const n = clip({ loop: { enabled: false, inPoint: 0.5, outPoint: 2.5 } });
    assert.equal(localToSourceOffset(n, 99), 2.5);
  });
});
describe("\u6DE1\u5316\u66F2\u7EBF", () => {
  it("\u7EBF\u6027\u7AEF\u70B9 0\u21921\uFF1B\u7B49\u529F\u7387\u7AEF\u70B9\u4E0E\u4E2D\u70B9", () => {
    assert.equal(fadeGain("linear", 0), 0);
    assert.equal(fadeGain("linear", 1), 1);
    assert.equal(fadeGain("equalPower", 0), 0);
    assert.equal(fadeGain("equalPower", 1), 1);
    assert.ok(Math.abs(fadeGain("equalPower", 0.5) - Math.SQRT1_2) < 1e-9);
  });
  it("\u7247\u6BB5\u957F\u5EA6\u6B63\u786E", () => {
    assert.equal(clipLength(clip()), 2);
  });
});
describe("\u7247\u6BB5\u72EC\u7ACB\u95EE\u9898\uFF08\u4E0D\u62B9\u7F16\u8F91\u5386\u53F2\uFF09", () => {
  const c = clip({ sourceDuration: 4 });
  const track = (over) => ({
    id: "t1",
    name: "t",
    sourceType: "file",
    blobKey: "b1",
    loop: false,
    muted: false,
    solo: false,
    gain: 1,
    channel: 0,
    color: "#fff",
    position: { x: 0, y: 0, z: 0 },
    status: "ready",
    duration: 4,
    clips: [c],
    activeClipId: "c1",
    ...over
  });
  it("\u5C31\u7EEA\u8F68\u65E0\u95EE\u9898", () => {
    assert.equal(getClipIssue(track({}), c, true), null);
  });
  it("\u672A\u89E3\u9501/\u672A\u89E3\u7801 \u2192 not-ready\uFF08\u63CF\u8FF0\u4ECD\u53EF\u5BA1\u9605\uFF09", () => {
    assert.equal(getClipIssue(track({ status: "pending", duration: void 0 }), c, true)?.kind, "not-ready");
    assert.equal(getClipIssue(track({}), c, false)?.kind, "not-ready");
  });
  it("\u89E3\u7801\u5931\u8D25\u4E0E Blob \u7F3A\u5931\u7ED9\u51FA\u4E0D\u540C\u72EC\u7ACB\u539F\u56E0", () => {
    const dec = getClipIssue(track({ status: "decode-error", errorMessage: "EncodingError" }), c, true);
    assert.equal(dec?.kind, "decode-error");
    const miss = getClipIssue(
      track({ status: "decode-error", errorMessage: "\u672C\u5730\u97F3\u9891 Blob \u7F3A\u5931" }),
      c,
      true
    );
    assert.equal(miss?.kind, "source-missing");
  });
  it("\u539F\u6587\u4EF6\u65F6\u957F\u53D8\u5316 \u2192 duration-changed\uFF08\u8FB9\u754C\u9700\u5BA1\u9605\uFF0C\u7247\u6BB5\u4FDD\u7559\uFF09", () => {
    const issue = getClipIssue(track({ duration: 3.2 }), c, true);
    assert.equal(issue?.kind, "duration-changed");
    assert.ok(issue.message.includes("3.200"));
  });
});
describe("\u5DE5\u7A0B\u8FC1\u79FB\uFF1A\u53EA\u8865\u7247\u6BB5\u63CF\u8FF0\u5B57\u6BB5", () => {
  it("v1 \u5DE5\u7A0B\u8FC1\u79FB\u4E3A v2\uFF0Ctracks \u5176\u4F59\u5B57\u6BB5\u4E0E blobs \u65E0\u6D89", () => {
    const v1 = {
      version: 1,
      tracks: [
        {
          id: "t1",
          name: "a",
          sourceType: "tone",
          loop: true,
          muted: false,
          solo: false,
          gain: 1,
          channel: 0,
          color: "#fff",
          position: { x: 1, y: 0, z: 0 },
          status: "ready"
        }
      ],
      listener: { position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, earHeight: 0 },
      spatial: {
        distanceModel: "inverse",
        refDistance: 1,
        rolloffFactor: 1,
        maxDistance: 30,
        positionTimeConstant: 0.06,
        hrtfIR: "none"
      },
      busGain: 1,
      masterGain: 1,
      savedAt: 0
    };
    const v2 = migrateDoc(v1);
    assert.equal(v2.version, 2);
    assert.deepEqual(v2.tracks[0].clips, []);
    assert.equal(v2.tracks[0].activeClipId, null);
    assert.equal(v2.tracks[0].name, "a");
  });
});
describe("\u64A4\u9500/\u91CD\u505A\uFF1A\u6574\u4F53\u66FF\u6362\u63CF\u8FF0\uFF0C\u65E0\u7D2F\u79EF\u8BEF\u5DEE\uFF0C\u7EDD\u4E0D\u590D\u5236\u97F3\u9891", () => {
  const c0 = clip({ inPoint: 1 / 3, outPoint: 2 / 3, fadeIn: { length: 0.01, curve: "linear" } });
  const c1 = {
    ...c0,
    inPoint: 0.4,
    outPoint: 0.9,
    fadeIn: { length: 0.02, curve: "equalPower" },
    version: 2
  };
  const entry = { type: "update", trackId: "t1", before: cloneClip(c0), after: cloneClip(c1) };
  it("\u64A4\u9500\u7CBE\u786E\u6062\u590D\u65E7\u8FB9\u754C/\u6DE1\u5316\uFF1B\u91CD\u505A\u7CBE\u786E\u6062\u590D\u65B0\u503C", () => {
    let clips = [cloneClip(c1)];
    clips = applyEntryToClips(clips, entry, "undo");
    assert.ok(Math.abs(clips[0].inPoint - 1 / 3) < 1e-15);
    assert.ok(Math.abs(clips[0].outPoint - 2 / 3) < 1e-15);
    assert.equal(clips[0].fadeIn.length, 0.01);
    assert.equal(clips[0].fadeIn.curve, "linear");
    assert.equal(clips[0].version, 1);
    clips = applyEntryToClips(clips, entry, "redo");
    assert.ok(Math.abs(clips[0].inPoint - 0.4) < 1e-15);
    assert.equal(clips[0].fadeIn.curve, "equalPower");
    assert.equal(clips[0].version, 2);
  });
  it("\u91CD\u590D\u64A4\u9500/\u91CD\u505A 200 \u8F6E\u540E\u6570\u503C\u4E0E\u9996\u8F6E\u5B8C\u5168\u4E00\u81F4\uFF08\u65E0\u7D2F\u79EF\u8BEF\u5DEE\uFF09", () => {
    let clips = [cloneClip(c1)];
    for (let i = 0; i < 200; i++) {
      clips = applyEntryToClips(clips, entry, "undo");
      clips = applyEntryToClips(clips, entry, "redo");
    }
    const c = clips[0];
    assert.equal(c.inPoint, 0.4);
    assert.equal(c.outPoint, 0.9);
    assert.equal(c.fadeIn.length, 0.02);
    clips = applyEntryToClips(clips, entry, "undo");
    assert.deepEqual(clips[0], entry.before);
  });
  it("create/delete \u7684\u64A4\u9500\u4E0E\u91CD\u505A\u589E\u5220\u7684\u662F\u540C\u4E00 id\uFF1B\u6D3B\u52A8\u7247\u6BB5\u88AB\u79FB\u9664\u65F6\u7ED9\u51FA id", () => {
    const add = { type: "create", trackId: "t1", clip: cloneClip(c0) };
    assert.deepEqual(applyEntryToClips([], add, "redo"), [c0]);
    assert.deepEqual(applyEntryToClips([c0], add, "undo"), []);
    assert.equal(entryRemovesClip(add, "undo"), c0.id);
    assert.equal(entryRemovesClip(add, "redo"), null);
    const del = { type: "delete", trackId: "t1", clip: cloneClip(c0) };
    assert.deepEqual(applyEntryToClips([], del, "undo"), [c0]);
    assert.deepEqual(applyEntryToClips([c0], del, "redo"), []);
    assert.equal(entryRemovesClip(del, "redo"), c0.id);
  });
});
