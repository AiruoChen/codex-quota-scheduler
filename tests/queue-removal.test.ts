import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { SqliteSchedulerRepository } from "../src/storage/scheduler-repository.js";
import { SqliteRecoveryRepository } from "../src/storage/recovery-repository.js";
import { dispatchQueueView, migrations } from "../src/storage/database.js";
import { inspectProfileDatabase } from "../src/storage/profile-snapshot.js";

const clock = { now: () => new Date("2026-10-27T00:00:00Z") };
const policy = { limitId: "codex", reservePercent: 10, quotaMaxAgeMs: 120000, pollIntervalMs: 1000 };
async function fixture(path = ":memory:") {
  const store = new SqliteStore(path, clock), queue = new SqliteSchedulerRepository(store.database, "fixture", "available", policy, clock);
  await store.tasks.create({ id: "fixture", name: "Fixture", enabled: true, priority: 1, projectDir: resolve(".local/fixture"), promptFile: resolve(".local/unused"), session: { mode: "new" } }, "PRIVATE_IMMUTABLE_PROMPT");
  return { store, queue, run: queue.enqueue("fixture") };
}

test("待核对移除需确认，解除阻塞且保持暂停，历史和同版本去重保留", async () => {
  const e = await fixture();
  try {
    const pending = await e.store.runs.update(e.run.id, { status: "needs_attention", error: "CODEX_AUTHORIZATION_MISMATCH" }, "queued");
    assert.throws(() => e.queue.remove(e.run.id), { code: "CONFIRM_REQUIRED" });
    assert.equal(e.queue.status().queue.length, 1); assert.deepEqual(e.queue.status().attention, [e.run.id]);
    e.queue.remove(e.run.id, true);
    assert.equal(e.queue.status().queue.length, 0); assert.deepEqual(e.queue.status().attention, []); assert.equal(e.queue.status().paused, true);
    assert.deepEqual(await e.store.runs.get(e.run.id), pending);
    assert.equal(e.queue.enqueue("fixture").id, e.run.id); assert.equal(e.queue.status().queue.length, 0);
    const token = e.queue.acquire(); e.queue.release(token); e.queue.resume(); assert.equal(e.queue.status().paused, false);
    await e.store.check();
  } finally { e.store.close(); }
});

test("活动执行、遗留执行权及伪装成排队的已提交记录不能删除", async () => {
  for (const state of ["running", "locked_attention", "submitted_queue"]) {
    const e = await fixture();
    try {
      if (state !== "submitted_queue") e.store.execution.claim(e.run.id);
      if (state === "locked_attention") await e.store.runs.update(e.run.id, { status: "needs_attention" }, "running");
      if (state === "submitted_queue") e.store.execution.event(e.run.id, "submission_started", {});
      assert.throws(() => e.queue.remove(e.run.id, true), { code: state === "submitted_queue" ? "RECOVERY_REQUIRED" : "EXECUTION_BUSY" });
      assert.equal(e.queue.status().queue.length, 1);
      assert.equal(e.store.database.connection.prepare("SELECT count(*) n FROM queue_removals").get()!.n, 0);
    } finally { e.store.close(); }
  }
});

test("缺少准确回合的应用操作不会撤销已有人工确认或修改暂停状态", async () => {
  const e = await fixture();
  try {
    await e.store.runs.update(e.run.id, { status: "needs_attention" }, "queued"); e.queue.acknowledge(e.run.id); e.queue.resume();
    const recovery = new SqliteRecoveryRepository(e.store.database, clock);
    assert.throws(() => recovery.beginReconcile(e.run.id), { code: "RECOVERY_TARGET_INCOMPLETE" });
    assert.deepEqual(e.queue.status().attention, []); assert.equal(e.queue.status().paused, false);
  } finally { e.store.close(); }
});

test("第九版数据迁移保留快照，移除后重启和备份仍保留历史与去重", async () => {
  const root = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(root, "quota-queue-removal-"))), path = join(directory, "state.sqlite");
  const e = await fixture(path); let store = e.store;
  try {
    const original = await store.runs.get(e.run.id);
    store.database.connection.exec(`DROP VIEW dispatch_queue; DROP TABLE timed_queue; DROP TABLE timed_occurrences; DROP TABLE timed_plans; DROP TABLE queue_order; DROP TABLE queue_removals; ${dispatchQueueView}; PRAGMA user_version=9`);
    store.close(); store = new SqliteStore(path, clock);
    assert.equal(store.database.connection.prepare("PRAGMA user_version").get()!.user_version, migrations.length);
    assert.deepEqual(await store.runs.get(e.run.id), original);
    new SqliteSchedulerRepository(store.database, "fixture", "available", policy, clock).remove(e.run.id);
    store.close(); store = new SqliteStore(path, clock);
    const queue = new SqliteSchedulerRepository(store.database, "fixture", "available", policy, clock);
    assert.equal(queue.status().queue.length, 0); assert.equal(queue.enqueue("fixture").id, e.run.id);
    assert.equal((await store.runs.get(e.run.id))!.promptSnapshot, original!.promptSnapshot);
    await store.check(); assert.equal(inspectProfileDatabase(path).schema, migrations.length);
  } finally { store.close(); assert.equal(dirname(directory), root); await rm(directory, { recursive: true, force: true }); }
});
