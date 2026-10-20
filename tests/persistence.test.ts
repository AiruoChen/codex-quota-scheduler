import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { RunUpdate, TaskDefinition } from "../src/domain/task.js";
import { migrations } from "../src/storage/database.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { promptHash } from "../src/storage/task-repository.js";
import { TaskService } from "../src/tasks/service.js";

const clock = { now: () => new Date("2026-10-19T00:00:00Z") };
function task(dir: string, id = "one"): TaskDefinition {
  return { id, name: "Task " + id, enabled: true, projectDir: dir, promptFile: join(dir, "prompt.md"), priority: 10, session: { mode: "new" } };
}

test("任务与运行记录跨连接保留，历史快照不受编辑和归档影响", async () => {
  const dir = await mkdtemp(join(tmpdir(), "persist-test-"));
  let store = new SqliteStore(join(dir, "state.sqlite"), clock);
  try {
    const definition = task(dir);
    await store.tasks.create(definition, "v1 prompt");
    const run = await store.runs.create("one");
    assert.equal(run.startedAt, null);
    await store.tasks.update({ ...definition, name: "Edited" }, "v2 prompt", 1);
    await assert.rejects(store.tasks.update(definition, "stale", 1), { code: "TASK_CONFLICT" });
    assert.deepEqual((await store.tasks.revisions("one")).map((item) => item.promptSnapshot), ["v1 prompt", "v2 prompt"]);
    store.close();
    store = new SqliteStore(join(dir, "state.sqlite"), clock);
    assert.equal((await store.tasks.get("one"))?.revision, 2);
    assert.equal((await store.runs.get(run.id))?.promptSnapshot, "v1 prompt");
    assert.equal((await store.runs.get(run.id))?.taskSnapshot.name, "Task one");
    await store.tasks.remove("one", 2);
    assert.deepEqual(await store.tasks.list(), []);
    assert.equal((await store.tasks.revisions("one")).length, 2);
    assert.equal((await store.runs.listByTask("one")).length, 1);
    await assert.rejects(store.tasks.create(definition, "new"), { code: "DUPLICATE_TASK" });
    await assert.rejects(store.runs.create("one"), { code: "TASK_NOT_FOUND" });
    assert.deepEqual(await store.check(), { ok: true, tasks: 1, runs: 1, versions: 2 });
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("首次导入只执行一次，批量冲突时所有新增任务和版本回滚", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seed-test-"));
  let store = new SqliteStore(join(dir, "state.sqlite"), clock);
  try {
    store.import([{ task: task(dir), prompt: "original" }], true);
    await store.tasks.remove("one", 1);
    store.close();
    store = new SqliteStore(join(dir, "state.sqlite"), clock);
    store.import([{ task: task(dir), prompt: "must not resurrect" }], true);
    assert.deepEqual(await store.tasks.list(), []);
    assert.throws(() => store.import([{ task: task(dir, "two"), prompt: "new" }, { task: task(dir), prompt: "conflict" }]), { code: "DUPLICATE_TASK" });
    assert.equal(await store.tasks.get("two"), null);
    assert.deepEqual(await store.tasks.revisions("two"), []);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("两条连接使用同一 revision 时只有一个更新可成功", async () => {
  const dir = await mkdtemp(join(tmpdir(), "concurrency-test-"));
  const first = new SqliteStore(join(dir, "state.sqlite"), clock);
  const second = new SqliteStore(join(dir, "state.sqlite"), clock);
  try {
    const definition = task(dir);
    await first.tasks.create(definition, "original");
    const stale = (await second.tasks.get("one"))!;
    await first.tasks.update({ ...definition, name: "First" }, "first", 1);
    await assert.rejects(second.tasks.update(stale, "second", stale.revision), { code: "TASK_CONFLICT" });
    assert.equal((await second.tasks.get("one"))?.promptSnapshot, "first");
  } finally { first.close(); second.close(); await rm(dir, { recursive: true, force: true }); }
});

test("运行状态持久化，终态不可重启且不能通过 patch 修改指令快照", async () => {
  const store = new SqliteStore(":memory:", clock);
  try {
    await store.tasks.create(task(tmpdir()), "immutable");
    const run = await store.runs.create("one");
    const update = { status: "running", promptSnapshot: "tampered" } as RunUpdate;
    const started = await store.runs.update(run.id, update, "queued");
    assert.equal(started.promptSnapshot, "immutable");
    assert.equal(started.startedAt, clock.now().toISOString());
    await assert.rejects(store.runs.update(run.id, { status: "running" }, "queued"), { code: "RUN_CONFLICT" });
    const completed = await store.runs.update(run.id, { status: "succeeded", output: "done" }, "running");
    assert.equal(completed.completedAt, clock.now().toISOString());
    await assert.rejects(store.runs.update(run.id, { status: "running" }, "succeeded"), { code: "RUN_TRANSITION" });
    assert.equal((await store.runs.get(run.id))?.output, "done");
  } finally { store.close(); }
});

test("从 v1 数据库迁移并保留已有指令；较新版本被拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "migration-test-"));
  const path = join(dir, "old.sqlite");
  const old = new DatabaseSync(path);
  old.exec(migrations[0]!);
  old.exec("PRAGMA user_version=1");
  old.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, 1, ?, ?, NULL)")
    .run("one", JSON.stringify(task(dir)), "legacy", promptHash("legacy"), clock.now().toISOString(), clock.now().toISOString());
  old.close();
  try {
    const migrated = new SqliteStore(path, clock);
    try {
      assert.equal((await migrated.tasks.revisions("one"))[0]?.promptSnapshot, "legacy");
      assert.equal(migrated.database.connection.prepare("PRAGMA user_version").get()?.user_version, 6);
    } finally { migrated.close(); }
    const future = new DatabaseSync(path);
    future.exec("PRAGMA user_version=99");
    future.close();
    assert.throws(() => new SqliteStore(path), { code: "STORAGE_VERSION" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("备份包含已提交数据和历史，已有备份不被覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backup-test-"));
  const store = new SqliteStore(join(dir, "state.sqlite"), clock);
  try {
    await store.tasks.create(task(dir), "saved");
    const run = await store.runs.create("one");
    const backup = store.database.backup(join(dir, "backup.sqlite"));
    assert.throws(() => store.database.backup(backup), { code: "BACKUP_FAILED" });
    const restored = new SqliteStore(backup, clock);
    try {
      assert.equal((await restored.tasks.get("one"))?.promptSnapshot, "saved");
      assert.equal((await restored.runs.get(run.id))?.promptSnapshot, "saved");
    } finally { restored.close(); }
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("坏数据库与错误校验和会报错，原文件不被重建", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corruption-test-"));
  const path = join(dir, "broken.sqlite");
  try {
    await writeFile(path, "not a SQLite database");
    assert.throws(() => new SqliteStore(path), { code: "STORAGE_INVALID" });
    assert.equal(await readFile(path, "utf8"), "not a SQLite database");
    const valid = new SqliteStore(join(dir, "valid.sqlite"), clock);
    try {
      await valid.tasks.create(task(dir), "good");
      valid.database.connection.prepare("UPDATE tasks SET prompt_snapshot='changed'").run();
      await assert.rejects(valid.check(), { code: "STORAGE_INVALID" });
    } finally { valid.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("拒绝修改其他应用的有效 SQLite 文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foreign-db-test-"));
  const path = join(dir, "foreign.sqlite");
  const existing = new DatabaseSync(path);
  existing.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('keep')");
  existing.close();
  try {
    assert.throws(() => new SqliteStore(path), { code: "STORAGE_FOREIGN" });
    const verify = new DatabaseSync(path);
    try {
      assert.equal(verify.prepare("SELECT value FROM unrelated").get()?.value, "keep");
      assert.equal(verify.prepare("PRAGMA user_version").get()?.user_version, 0);
    } finally { verify.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("文件导入保存当时指令，关闭后无需原提示词文件也可读取", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prompt-test-"));
  const store = new SqliteStore(join(dir, "state.sqlite"), clock);
  try {
    await writeFile(join(dir, "prompt.md"), "first text");
    const json = join(dir, "task.json");
    await writeFile(json, JSON.stringify(task(dir)));
    const service = new TaskService(store);
    await service.add(json);
    await writeFile(join(dir, "prompt.md"), "edited externally");
    assert.equal((await store.runs.create("one")).promptSnapshot, "first text");
    await service.update(json, 1);
    assert.equal((await store.tasks.get("one"))?.promptSnapshot, "edited externally");
    await rm(join(dir, "prompt.md"));
    await service.enable("one", false, 2);
    assert.equal((await store.tasks.get("one"))?.promptSnapshot, "edited externally");
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
