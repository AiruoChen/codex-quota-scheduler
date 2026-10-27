import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagementService } from "../src/management/service.js";
import { parseConfig } from "../src/config/load.js";
import { recoveryEvent } from "../src/storage/recovery-repository.js";
import type { DesktopFeed } from "../src/domain/notifications.js";
import type { QuotaSnapshot } from "../src/domain/quota.js";

const epoch = Date.parse("2026-10-26T00:00:00Z");
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "desktop-feed-")); let time = epoch;
  const clock = { now: () => new Date(time) }, configPath = join(dir, "config.json");
  await writeFile(join(dir, "tasks.json"), "[]");
  const config = parseConfig({ schemaVersion: 1, provider: "mock", tasksFile: "tasks.json", storage: { databasePath: "state.sqlite" }, pollIntervalMs: 1000, quotaMaxAgeMs: 10000, reservePercent: 10, limitId: "codex" }, configPath);
  const service = new ManagementService(config, configPath, () => {}, clock); await service.initialize(); await service.loopAction("monitor-stop");
  const store = await service.app.storage();
  await service.saveTask({ definition: { id: "fixture", name: "PRIVATE_SYNTHETIC_NAME", enabled: true, projectDir: dir, priority: 1, session: { mode: "new" } }, prompt: "PRIVATE_SYNTHETIC_BODY" });
  const read = (previous?: DesktopFeed) => service.desktopFeed({ scope: previous?.scope ?? null, cursor: previous?.cursor ?? null });
  return { dir, clock, store, service, read, advance(ms: number) { time += ms; }, cleanup: async () => { await service.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("首次连接不重播历史；进行中的最终落盘不能被检查点跳过，事件不含正文与路径", async () => {
  const env = await setup();
  try {
    const baseline = await env.read();
    const run = await env.store.runs.create("fixture"); await env.store.runs.update(run.id, { status: "running" }, "queued");
    env.store.execution.event(run.id, "execution_finished", { status: "succeeded" });
    const firstDuringFinish = await env.read(); assert.equal(firstDuringFinish.cursor.execution, baseline.cursor.execution);
    const pending = await env.read(baseline); assert.equal(pending.cursor.execution, baseline.cursor.execution); assert.deepEqual(pending.events, []);
    await env.store.runs.update(run.id, { status: "succeeded", output: "PRIVATE_SYNTHETIC_OUTPUT" }, "running");
    const finished = await env.read(pending); assert.equal(finished.events[0]?.kind, "task_succeeded"); assert.equal(finished.events[0]?.runId, run.id);
    assert.ok(!JSON.stringify(finished).includes("PRIVATE_SYNTHETIC")); assert.ok(!JSON.stringify(finished).includes(env.dir));
    assert.deepEqual((await env.read(finished)).events, []); assert.deepEqual((await env.read()).events, []);
    const reset = await env.service.desktopFeed({ scope: finished.scope, cursor: { ...finished.cursor, execution: finished.cursor.execution + 999 } });
    assert.equal(reset.baseline, true); assert.deepEqual(reset.events, []);
  } finally { await env.cleanup(); }
});

test("执行与修复共用唯一结果来源；后续修复不能重复通知已结束任务", async () => {
  const env = await setup();
  try {
    let cursor = await env.read();
    const run = await env.store.runs.create("fixture"); await env.store.runs.update(run.id, { status: "running" }, "queued");
    env.store.execution.event(run.id, "execution_finished", { status: "needs_attention" }); await env.store.runs.update(run.id, { status: "needs_attention" }, "running");
    recoveryEvent(env.store.database, env.clock, run.id, "execution_released", { status: "needs_attention" });
    const first = await env.read(cursor); assert.equal(first.events.length, 1); assert.equal(first.events[0]?.kind, "needs_attention"); cursor = first;
    recoveryEvent(env.store.database, env.clock, run.id, "needs_attention", { code: "fixture" });
    assert.deepEqual((await env.read(cursor)).events, []);
    const other = await env.store.runs.create("fixture"); await env.store.runs.update(other.id, { status: "running" }, "queued"); await env.store.runs.update(other.id, { status: "needs_attention" }, "running");
    recoveryEvent(env.store.database, env.clock, other.id, "needs_attention", { code: "fixture" }); recoveryEvent(env.store.database, env.clock, other.id, "execution_released", { status: "needs_attention" });
    const repaired = await env.read(cursor); assert.equal(repaired.events.filter((event) => event.runId === other.id).length, 1);
  } finally { await env.cleanup(); }
});

test("额度刷新通知要求完整查询已确认且来源/时间仍有效；可用性阻塞不抹掉刷新事实", async () => {
  const env = await setup();
  try {
    const monitor = await env.service.app.monitoring();
    const snapshot = (now: Date, reset: number): QuotaSnapshot => ({ source: "mock", fetchedAt: now.toISOString(), buckets: [{ id: "codex", name: null, planType: null, reachedType: null,
      windows: [{ slot: "primary", durationMinutes: 75, usedPercent: 10, remainingPercent: 90, resetsAt: new Date(reset).toISOString() }, { slot: "secondary", durationMinutes: 4321, usedPercent: 100, remainingPercent: 0, resetsAt: new Date(epoch + 100000).toISOString() }] }] });
    monitor.repository.record({ snapshot: snapshot(env.clock.now(), epoch + 1000) });
    const baseline = await env.read(); env.advance(2000); monitor.repository.record({ snapshot: snapshot(env.clock.now(), epoch + 60000) });
    const reset = await env.read(baseline); assert.ok(reset.events.some((event) => event.kind === "quota_reset")); assert.equal(monitor.repository.status()?.availability.status, "blocked");
    env.advance(11000); assert.ok(!(await env.read(baseline)).events.some((event) => event.kind === "quota_reset"));
    const account = { type: "chatgpt" as const, email: "first@example.invalid", planType: "fixture", workspaceId: null };
    monitor.repository.record({ snapshot: { ...snapshot(env.clock.now(), env.clock.now().getTime() + 1000), source: "codex", account } });
    const beforeSwitch = await env.read(reset); env.advance(2000); monitor.repository.record({ snapshot: { ...snapshot(env.clock.now(), env.clock.now().getTime() + 60000), source: "codex", account } });
    monitor.repository.record({ snapshot: { ...snapshot(env.clock.now(), env.clock.now().getTime() + 60000), source: "codex", account: { ...account, email: "second@example.invalid" } } });
    assert.ok(!(await env.read(beforeSwitch)).events.some((event) => event.kind === "quota_reset"));
  } finally { await env.cleanup(); }
});
