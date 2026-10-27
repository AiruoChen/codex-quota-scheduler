import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { SqliteSchedulerRepository } from "../src/storage/scheduler-repository.js";
import { ProjectPicker } from "../src/desktop/project-picker.js";
import type { TaskDefinition } from "../src/domain/task.js";
import { resolve } from "node:path";

const clock = { now: () => new Date("2026-10-25T00:00:00Z") };
const definition = (id: string): TaskDefinition => ({ id, name: `任务 ${id}`, projectDir: resolve(".local/fixture-project"), promptFile: resolve(".local/unused-prompt.md"), enabled: true, priority: 1, session: { mode: "new" } });
const policy = { limitId: "codex", quotaMaxAgeMs: 10000, reservePercent: 10, pollIntervalMs: 1000 };

test("任务分页在 1000 条定义下按名称/目录/状态筛选，不返回正文，特殊字符按字面匹配", async (t) => {
  const store = new SqliteStore(":memory:", clock);
  try {
    store.database.transaction(() => { for (let index = 0; index < 1000; index++) store.tasks.insert({ ...definition(`task-${String(index).padStart(4, "0")}`), enabled: index % 2 === 0 }, "private fixture body"); });
    const start = performance.now();
    const page = await store.tasks.query({ search: "TASK-00", enabled: "enabled", offset: 25, limit: 25 });
    t.diagnostic(`1000-task filtered page: ${(performance.now() - start).toFixed(1)} ms`);
    assert.equal(page.total, 50); assert.equal(page.items.length, 25); assert.equal(page.items[0]?.id, "task-0050");
    assert.ok(!JSON.stringify(page).includes("private fixture body"));
    assert.equal((await store.tasks.query({ search: "%_", enabled: "all", offset: 0, limit: 25 })).total, 0);
    assert.equal((await store.tasks.query({ search: "fixture-project", enabled: "disabled", offset: 0, limit: 1 })).total, 500);
    for (const input of [{ offset: -1 }, { limit: 101 }, { enabled: "invalid" }]) await assert.rejects(store.tasks.query({ search: "", enabled: "all", offset: 0, limit: 25, ...input } as Parameters<typeof store.tasks.query>[0]), { code: "INVALID_ARGUMENT" });
  } finally { store.close(); }
});

test("入队预览版本在事务内校验；重复版本去重，旧快照优先级/目录/正文不变", async () => {
  const store = new SqliteStore(":memory:", clock);
  const scheduler = new SqliteSchedulerRepository(store.database, "fixture", "available", policy, clock);
  try {
    const task = await store.tasks.create(definition("one"), "first snapshot");
    const first = scheduler.enqueue(task.id, 1);
    await store.tasks.update({ ...task, priority: 99, projectDir: resolve(".local/second-project") }, "second snapshot", 1);
    assert.throws(() => scheduler.enqueue(task.id, 1), { code: "TASK_CONFLICT" });
    assert.throws(() => store.execution.claimNew(task.id, 1), { code: "TASK_CONFLICT" });
    assert.equal((await store.runs.recent()).length, 1);
    const next = scheduler.enqueue(task.id, 2); assert.equal(scheduler.enqueue(task.id, 2).id, next.id);
    const summary = scheduler.status().queue;
    assert.equal(summary.length, 2); assert.equal(summary[0]?.priority, 1); assert.equal(summary[1]?.priority, 99);
    assert.equal(summary[0]?.projectDir, task.projectDir); assert.equal(summary[0]?.sequence, 1);
    assert.equal((await store.runs.get(first.id))?.promptSnapshot, "first snapshot");
    scheduler.remove(next.id); assert.equal(scheduler.enqueue(task.id, 2).id, next.id);
    assert.equal(scheduler.status().paused, true);
    await store.tasks.remove(task.id, 2); assert.equal(scheduler.status().queue[0]?.enabled, null);
    assert.equal((await store.runs.get(first.id))?.promptSnapshot, "first snapshot");
  } finally { store.close(); }
});

test("目录选择拒绝参数、不可信来源和并发请求；来源变化或取消不返回路径", async () => {
  let trusted = false, calls = 0, release!: (value: string | null) => void;
  const picker = new ProjectPicker({ trusted: () => trusted, pick: () => { calls++; return new Promise((done) => { release = done; }); } });
  await assert.rejects(picker.choose([]), { code: "HTTP_FORBIDDEN" });
  trusted = true; await assert.rejects(picker.choose(["arbitrary-path"]), { code: "INVALID_ARGUMENT" });
  const pending = picker.choose([]); await assert.rejects(picker.choose([]), { code: "MANAGEMENT_BUSY" });
  trusted = false; release("fixture-path"); assert.equal(await pending, null);
  trusted = true; const cancelled = picker.choose([]); release(null); assert.equal(await cancelled, null);
  const selected = picker.choose([]); release("fixture-path"); assert.equal(await selected, "fixture-path"); assert.equal(calls, 3);
});
