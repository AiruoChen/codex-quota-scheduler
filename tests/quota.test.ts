import assert from "node:assert/strict";
import test from "node:test";
import { normalizeQuota } from "../src/adapters/codex/normalize-quota.js";

const now = new Date("2026-10-19T00:00:00Z");

test("按窗口时长保留周额度，不假设 primary 是五小时", () => {
  const snapshot = normalizeQuota({ rateLimits: {
    limitId: "codex", primary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1792454400 }, secondary: null,
  } }, now, "codex");
  assert.equal(snapshot.buckets[0]?.windows.length, 1);
  assert.equal(snapshot.buckets[0]?.windows[0]?.durationMinutes, 10080);
  assert.equal(snapshot.buckets[0]?.windows[0]?.remainingPercent, 69);
  assert.equal(snapshot.buckets[0]?.windows[0]?.resetsAt, "2026-10-20T00:00:00.000Z");
});

test("空响应与缺失字段保留未知状态", () => {
  assert.deepEqual(normalizeQuota(null, now, "codex").buckets, []);
  const window = normalizeQuota({ rateLimitsByLimitId: { codex: { primary: {} } } }, now, "codex").buckets[0]?.windows[0];
  assert.equal(window?.remainingPercent, null);
  assert.equal(window?.durationMinutes, null);
  assert.equal(window?.resetsAt, null);
});

test("多额度桶优先，保留各自身份，不把额度相加", () => {
  const result = normalizeQuota({
    rateLimits: { limitId: "legacy" },
    rateLimitsByLimitId: { codex: { secondary: null }, other: { primary: null } },
  }, now, "codex");
  assert.deepEqual(result.buckets.map((bucket) => bucket.id), ["codex", "other"]);
});

test("异常比例与超范围时间不会产生虚假可用额度", () => {
  const windows = normalizeQuota({ rateLimits: { limitId: "codex",
    primary: { usedPercent: "25", resetsAt: 1e20 },
    secondary: { usedPercent: 105 },
  } }, now, "codex").buckets[0]?.windows;
  assert.equal(windows?.[0]?.remainingPercent, null);
  assert.equal(windows?.[0]?.resetsAt, null);
  assert.equal(windows?.[1]?.remainingPercent, 0);
});
