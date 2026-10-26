import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, unlink, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DesktopDataTransfer, selectedProfile } from "../src/desktop/data-transfer.js";
import { initializeDesktopProfile, type DesktopOptions } from "../src/desktop/profile.js";
import { loadConfig } from "../src/config/load.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { inspectProfileDatabase } from "../src/storage/profile-snapshot.js";
import { migrations } from "../src/storage/database.js";
import { claimInstance } from "../src/runtime/instance.js";

const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "migration 中文 &-"));
  const source: DesktopOptions = { dataDir: join(root, "old"), configPath: join(root, "old/config/local.json"), debugging: false };
  const target: DesktopOptions = { dataDir: join(root, "desktop"), configPath: join(root, "desktop/config/local.json"), debugging: false };
  await initializeDesktopProfile(source); await initializeDesktopProfile(target);
  const config = await loadConfig(source.configPath);
  const store = new SqliteStore(config.storage.databasePath);
  const task = { id: "fixture", name: "Private synthetic", enabled: true, projectDir: join(root, "project"), promptFile: join(root, "prompt.md"), priority: 2, session: { mode: "new" as const } };
  await store.tasks.create(task, "first synthetic prompt");
  const run = await store.runs.create(task.id);
  await store.tasks.update({ ...task, name: "Second revision" }, "second synthetic prompt", 1);
  await store.runs.update(run.id, { status: "needs_attention", output: "synthetic partial output" }, "queued");
  store.execution.event(run.id, "submission_started", { threadId: "fixture-thread", turnId: "fixture-turn" });
  store.close();
  return { root, source, target, config, run, task, manager: new DesktopDataTransfer(target, "0.2.0"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("导入保留任务版本、快照、事件与相对路径语义；源文件不变，切换最后发生且队列暂停", async () => {
  const e = await setup();
  try {
    const old = new DatabaseSync(e.config.storage.databasePath);
    old.exec("PRAGMA user_version=6;DELETE FROM metadata WHERE key='database_identity'"); old.close();
    const sourceBytes = await readFile(e.config.storage.databasePath), configBytes = await readFile(e.source.configPath);
    const preview = await e.manager.preview(e.source.configPath);
    assert.equal(preview.schema, 6); assert.equal(preview.versions, 2); assert.equal(preview.attention, 1);
    await e.manager.commit(preview.token);
    assert.deepEqual(await readFile(e.config.storage.databasePath), sourceBytes);
    assert.deepEqual(await readFile(e.source.configPath), configBytes);
    assert.equal(await selectedProfile(e.target.dataDir), e.target.configPath);
    const imported = await loadConfig(e.target.configPath), store = new SqliteStore(imported.storage.databasePath);
    try {
      assert.equal((await store.tasks.get(e.task.id))!.revision, 2);
      assert.equal((await store.runs.get(e.run.id))!.promptSnapshot, "first synthetic prompt");
      assert.equal((await store.runs.get(e.run.id))!.output, "synthetic partial output");
      assert.equal((await store.tasks.get(e.task.id))!.projectDir, e.task.projectDir);
      assert.equal(store.database.connection.prepare("SELECT paused FROM scheduler_control").get()!.paused, 1);
      assert.equal(Number(store.database.connection.prepare("PRAGMA user_version").get()!.user_version), migrations.length);
      assert.equal(store.execution.events(e.run.id).length, 1);
    } finally { store.close(); }
    const view = await e.manager.view(); assert.ok(view.backup); assert.equal(view.profiles.length, 2);
    assert.equal(inspectProfileDatabase(join(view.backup!, "state.sqlite")).schema, 6);
    await e.manager.switchProfile("default"); assert.equal(e.target.configPath, join(e.target.dataDir, "config/local.json"));
  } finally { await e.cleanup(); }
});

test("一致性备份包含未检查点 WAL 数据，不直接复制源主文件", async () => {
  const e = await setup(); const db = new DatabaseSync(e.config.storage.databasePath);
  try {
    db.exec("PRAGMA wal_autocheckpoint=0");
    db.prepare("UPDATE runs SET data_json=json_set(data_json,'$.output',?) WHERE id=?").run("WAL-only synthetic output", e.run.id);
    const before = hash(await readFile(e.config.storage.databasePath));
    const preview = await e.manager.preview(e.source.configPath); await e.manager.commit(preview.token);
    assert.equal(hash(await readFile(e.config.storage.databasePath)), before);
    const migrated = await loadConfig(e.target.configPath), store = new SqliteStore(migrated.storage.databasePath);
    try { assert.equal((await store.runs.get(e.run.id))!.output, "WAL-only synthetic output"); } finally { store.close(); }
  } finally { db.close(); await e.cleanup(); }
});

test("预检后数据或配置变化拒绝提交，现有目标不覆盖，不发生合库", async () => {
  const e = await setup();
  try {
    const preview = await e.manager.preview(e.source.configPath);
    const db = new DatabaseSync(e.config.storage.databasePath); db.exec("INSERT INTO metadata VALUES('changed','yes')"); db.close();
    await assert.rejects(e.manager.commit(preview.token), { code: "MIGRATION_CHANGED" });
    assert.equal(await selectedProfile(e.target.dataDir), e.target.configPath);
    const next = await e.manager.preview(e.source.configPath); await mkdir(next.target, { recursive: true });
    await writeFile(join(next.target, "keep.txt"), "do not replace");
    await assert.rejects(e.manager.commit(next.token), { code: "MIGRATION_TARGET_EXISTS" });
    assert.equal(await readFile(join(next.target, "keep.txt"), "utf8"), "do not replace");
  } finally { await e.cleanup(); }
});

test("活动、未知进程与服务记录阻止导入；遗留的已死执行权原样保留", async () => {
  const e = await setup();
  try {
    // Find an unallocated PID without assuming a process can be safely killed.
    let dead = 2147483647;
    for (;;) { try { process.kill(dead, 0); dead--; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; dead--; } }
    const db = new DatabaseSync(e.config.storage.databasePath);
    try {
      db.prepare("INSERT INTO execution_lock VALUES(1,?,?,0,1)").run(e.run.id, process.pid);
      await assert.rejects(e.manager.preview(e.source.configPath), { code: "MIGRATION_SOURCE_ACTIVE" });
      db.exec("UPDATE execution_lock SET owner_pid=0");
      await assert.rejects(e.manager.preview(e.source.configPath), { code: "MIGRATION_SOURCE_ACTIVE" });
      db.prepare("UPDATE execution_lock SET owner_pid=?").run(dead);
    } finally { db.close(); }
    const instance = await claimInstance(e.source.configPath);
    await assert.rejects(e.manager.preview(e.source.configPath), { code: "MIGRATION_SOURCE_ACTIVE" }); await instance.release();
    const preview = await e.manager.preview(e.source.configPath); await e.manager.commit(preview.token);
    const config = await loadConfig(e.target.configPath), imported = new SqliteStore(config.storage.databasePath);
    try { assert.equal(imported.execution.active()!.ownerPid, dead); assert.equal((await imported.runs.get(e.run.id))!.status, "needs_attention"); }
    finally { imported.close(); }
  } finally { await e.cleanup(); }
});

test("转换验证失败保留备份、暂存失败记录和当前配置；不能重建空库", async () => {
  const e = await setup();
  try {
    const db = new DatabaseSync(e.config.storage.databasePath); db.exec("UPDATE tasks SET prompt_hash='bad'"); db.close();
    const sourceHash = hash(await readFile(e.config.storage.databasePath)), original = e.target.configPath;
    const preview = await e.manager.preview(e.source.configPath);
    await assert.rejects(e.manager.commit(preview.token), { code: "STORAGE_INVALID" });
    assert.equal(e.target.configPath, original); assert.equal(hash(await readFile(e.config.storage.databasePath)), sourceHash);
    const stage = join(e.target.dataDir, "profiles", `.stage-${preview.token}`);
    assert.equal(JSON.parse(await readFile(join(stage, "failure.json"), "utf8")).code, "STORAGE_INVALID");
    assert.ok((await readdir(join(e.target.dataDir, "backups"))).length);
    await writeFile(e.config.storage.databasePath, "corrupted database");
    await assert.rejects(e.manager.preview(e.source.configPath), { code: "STORAGE_INVALID" });
    assert.equal(await readFile(e.config.storage.databasePath, "utf8"), "corrupted database");
  } finally { await e.cleanup(); }
});

test("备份校验、恢复为独立副本与原默认配置保留；损坏或较新版本拒绝", async () => {
  const e = await setup();
  try {
    const manager = new DesktopDataTransfer(e.source, "0.2.0"); const backup = await manager.backup();
    const manifestPath = join(backup, "backup-manifest.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, clientVersion: "9.0.0" }));
    await assert.rejects(e.manager.preview(join(backup, "config.json")), { code: "DESKTOP_DOWNGRADE" });
    await writeFile(manifestPath, JSON.stringify(manifest));
    const preview = await e.manager.preview(join(backup, "config.json")); await e.manager.commit(preview.token);
    await writeFile(join(backup, "tasks.json"), " [ ]\n");
    await assert.rejects(e.manager.preview(join(backup, "config.json")), { code: "MIGRATION_BACKUP_INVALID" });
    const db = new DatabaseSync(e.config.storage.databasePath); db.exec("PRAGMA user_version=999"); db.close();
    await assert.rejects(e.manager.preview(e.source.configPath), { code: "STORAGE_VERSION" });
    await writeFile(join(e.target.dataDir, "desktop-profile.json"), "broken");
    await assert.rejects(selectedProfile(e.target.dataDir), { code: "MIGRATION_STATE_INVALID" });
    assert.equal(await readFile(join(e.target.dataDir, "desktop-profile.json"), "utf8"), "broken");
  } finally { await e.cleanup(); }
});

test("首次打开旧版本先备份；模式迁移保留原件备份，重复启动不重复备份，禁止数据版本降级", async () => {
  const e = await setup();
  try {
    const manager = new DesktopDataTransfer(e.source, "0.2.0");
    const db = new DatabaseSync(e.config.storage.databasePath); db.exec("PRAGMA user_version=6;DELETE FROM metadata WHERE key='database_identity'"); db.close();
    await manager.prepareStartup(); const view = await manager.view(); assert.ok(view.backup);
    assert.equal(inspectProfileDatabase(join(view.backup!, "state.sqlite")).schema, 6);
    assert.equal(inspectProfileDatabase(e.config.storage.databasePath).schema, migrations.length);
    const backups = await readdir(join(e.source.dataDir, "backups")); await manager.prepareStartup();
    assert.deepEqual(await readdir(join(e.source.dataDir, "backups")), backups);
    await assert.rejects(new DesktopDataTransfer(e.source, "0.1.0").prepareStartup(), { code: "DESKTOP_DOWNGRADE" });
    assert.ok(await readFile(join(dirname(e.source.configPath), "local.json")));
  } finally { await e.cleanup(); }
});

test("过期预览和数据写锁拒绝操作；已初始化但缺失的数据库不能重建", async () => {
  const e = await setup();
  try {
    let time = Date.parse("2026-10-26T00:00:00Z");
    const manager = new DesktopDataTransfer(e.target, "0.2.0", false, () => {}, () => new Date(time));
    const preview = await manager.preview(e.source.configPath); time += 600001;
    await assert.rejects(manager.commit(preview.token), { code: "MIGRATION_PREVIEW_EXPIRED" });
    const lock = join(e.target.dataDir, "data-transfer.lock"); await writeFile(lock, "synthetic lock");
    await assert.rejects(manager.preview(e.source.configPath), { code: "MIGRATION_BUSY" });
    assert.equal(await readFile(lock, "utf8"), "synthetic lock"); await unlink(lock);
    await manager.prepareStartup(); await manager.opened();
    await assert.rejects(manager.prepareStartup(), { code: "STORAGE_MISSING" });
  } finally { await e.cleanup(); }
});

test("已种入的旧库无需丢失的导入清单，配置和任务路径按原位置解析", async () => {
  const e = await setup();
  try {
    const raw = JSON.parse(await readFile(e.source.configPath, "utf8"));
    raw.codex = { home: "../codex-home", executable: "../tools/codex" };
    await writeFile(e.source.configPath, JSON.stringify(raw));
    const db = new DatabaseSync(e.config.storage.databasePath); db.exec("INSERT INTO metadata VALUES('tasks_seeded','true')"); db.close();
    await unlink(e.config.tasksFile);
    const preview = await e.manager.preview(e.source.configPath); await e.manager.commit(preview.token);
    const config = await loadConfig(e.target.configPath);
    assert.equal(config.codex.home, join(e.source.dataDir, "codex-home"));
    assert.equal(config.codex.executable, join(e.source.dataDir, "tools/codex"));
    assert.equal(await readFile(config.tasksFile, "utf8"), "[]\n");
  } finally { await e.cleanup(); }
});

test("旧模式仍有活动执行权时拒绝升级，数据目录联接不能重定向迁移写入", async () => {
  const e = await setup();
  try {
    const db = new DatabaseSync(e.config.storage.databasePath);
    db.prepare("INSERT INTO execution_lock VALUES(1,?,?,0,1)").run(e.run.id, process.pid);
    db.exec("PRAGMA user_version=6;DELETE FROM metadata WHERE key='database_identity'"); db.close();
    const before = hash(await readFile(e.config.storage.databasePath));
    assert.throws(() => new SqliteStore(e.config.storage.databasePath), { code: "STORAGE_BUSY" });
    assert.equal(hash(await readFile(e.config.storage.databasePath)), before);
    const unlock = new DatabaseSync(e.config.storage.databasePath); unlock.exec("DELETE FROM execution_lock"); unlock.close();
    const outside = join(e.root, "outside"); await mkdir(outside);
    await symlink(outside, join(e.target.dataDir, "profiles"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(e.manager.preview(e.source.configPath), { code: "MIGRATION_PATH" });
    assert.deepEqual(await readdir(outside), []);
  } finally { await e.cleanup(); }
});

test("新版导入后尚未首次启动的活动配置拒绝降级，原数据和活动指针保持不变", async () => {
  const e = await setup();
  try {
    const newer = new DesktopDataTransfer(e.target, "9.9.9");
    const preview = await newer.preview(e.source.configPath); await newer.commit(preview.token);
    const active = await selectedProfile(e.target.dataDir), config = await loadConfig(active);
    const database = await readFile(config.storage.databasePath), pointer = await readFile(join(e.target.dataDir, "desktop-profile.json"));
    const backups = await readdir(join(e.target.dataDir, "backups"));
    const older = new DesktopDataTransfer({ ...e.target, configPath: active }, "0.3.0");
    await assert.rejects(older.prepareStartup(), { code: "DESKTOP_DOWNGRADE" });
    await assert.rejects(older.opened(), { code: "DESKTOP_DOWNGRADE" });
    assert.deepEqual(await readFile(config.storage.databasePath), database);
    assert.deepEqual(await readFile(join(e.target.dataDir, "desktop-profile.json")), pointer);
    assert.deepEqual(await readdir(join(e.target.dataDir, "backups")), backups);
    // A supported client can still open the exact same imported data.
    await newer.prepareStartup(); await newer.opened();
    await assert.rejects(older.prepareStartup(), { code: "DESKTOP_DOWNGRADE" });
  } finally { await e.cleanup(); }
});

test("活动导入标记缺失或损坏时不能启动，也不能用旧客户端再次导入或切换", async () => {
  const e = await setup();
  try {
    const newer = new DesktopDataTransfer(e.target, "9.9.9");
    const preview = await newer.preview(e.source.configPath); await newer.commit(preview.token);
    const imported = e.target.configPath, markerPath = join(dirname(imported), "profile.json"), marker = await readFile(markerPath);
    const config = await loadConfig(imported), database = await readFile(config.storage.databasePath);
    const older = new DesktopDataTransfer({ ...e.target }, "0.3.0");
    await assert.rejects(older.preview(imported), { code: "DESKTOP_DOWNGRADE" });
    await newer.switchProfile("default");
    await assert.rejects(new DesktopDataTransfer({ ...e.target }, "0.3.0").switchProfile(preview.token), { code: "DESKTOP_DOWNGRADE" });
    await writeFile(markerPath, JSON.stringify({ format: 1, clientVersion: "invalid" }));
    await assert.rejects(new DesktopDataTransfer({ ...e.target, configPath: imported }, "9.9.9").prepareStartup(), { code: "MIGRATION_STATE_INVALID" });
    await unlink(markerPath);
    await assert.rejects(new DesktopDataTransfer({ ...e.target, configPath: imported }, "9.9.9").prepareStartup(), { code: "MIGRATION_STATE_INVALID" });
    assert.deepEqual(await readFile(config.storage.databasePath), database);
    await writeFile(markerPath, marker);
  } finally { await e.cleanup(); }
});
