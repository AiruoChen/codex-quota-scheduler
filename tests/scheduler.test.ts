import assert from "node:assert/strict";
import test from "node:test";
import { normalizeQuota } from "../src/adapters/codex/normalize-quota.js";
import type { TaskDefinition } from "../src/domain/task.js";
import { evaluateQueue } from "../src/scheduler/evaluate.js";

const now = new Date("2026-10-19T00:00:00Z");
const task: TaskDefinition = {
  id: "one", name: "One", enabled: true, projectDir: ".", promptFile: "prompt.md", priority: 1, session: { mode: "new" },
};
const policy = { limitId: "codex", quotaMaxAgeMs: 120000, reservePercent: 10 };
function quota(short = 0, weekly = 25) {
  return normalizeQuota({ rateLimitsByLimitId: { codex: {
    primary: { usedPercent: short, windowDurationMins: 300 },
    secondary: { usedPercent: weekly, windowDurationMins: 10080 },
  } } }, now, "mock");
}

test("五小时已恢复但周额度耗尽时继续等待", () => {
  assert.deepEqual(evaluateQueue(quota(0, 100), [task], policy, now, false), { action: "wait", reason: "quota_exhausted" });
});

test("过期数据与未来时间不会触发任务", () => {
  for (const time of [new Date(now.getTime() + 120001), new Date(now.getTime() - 1)]) {
    assert.deepEqual(evaluateQueue(quota(), [task], policy, time, false), { action: "wait", reason: "stale_quota" });
  }
});

test("缺失额度桶或窗口数据时等待", () => {
  for (const result of [{}, { rateLimitsByLimitId: { codex: { primary: {} } } }]) {
    const snapshot = normalizeQuota(result, now, "mock");
    assert.deepEqual(evaluateQueue(snapshot, [task], policy, now, false), { action: "wait", reason: "unknown_quota" });
  }
});

test("保留阈值达到时停止提交", () => {
  assert.deepEqual(evaluateQueue(quota(90), [task], policy, now, false), { action: "wait", reason: "reserve_reached" });
});

test("串行互斥与空队列", () => {
  assert.deepEqual(evaluateQueue(quota(), [task], policy, now, true), { action: "wait", reason: "busy" });
  assert.deepEqual(evaluateQueue(quota(), [{ ...task, enabled: false }], policy, now, false), { action: "wait", reason: "empty_queue" });
});

test("优先执行启用的高优先级任务，保持原队列顺序", () => {
  const tasks = [task, { ...task, id: "two", priority: 20 }, { ...task, id: "disabled", priority: 99, enabled: false }];
  assert.deepEqual(evaluateQueue(quota(), tasks, policy, now, false), { action: "run", taskId: "two" });
  assert.equal(tasks[0]?.id, "one");
});

test("服务端限制状态优先于显示的剩余比例", () => {
  const snapshot = quota();
  snapshot.buckets[0]!.reachedType = "usage_limit";
  assert.deepEqual(evaluateQueue(snapshot, [task], policy, now, false), { action: "wait", reason: "quota_exhausted" });
});
