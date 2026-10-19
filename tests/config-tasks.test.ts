import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/load.js";
import { loadTasks } from "../src/tasks/load.js";

test("示例配置可运行模拟预览且明确标注来源", async () => {
  const config = await loadConfig("config/example.json");
  const app = createApp({ ...config, storage: { databasePath: ":memory:" } }, { now: () => new Date("2026-10-19T00:00:00Z") });
  try {
  const preview = await app.preview();
  assert.equal(preview.mode, "preview_only");
  assert.equal(preview.snapshot.source, "mock");
  assert.deepEqual(preview.decision, { action: "run", taskId: "review-project" });
  const tasks = await app.tasks();
  assert.ok(isAbsolute(tasks[0]!.projectDir));
  assert.ok(isAbsolute(tasks[0]!.promptFile));
  } finally { await app.close(); }
});

test("真实 provider 找不到 CLI 时明确报错，不回退为模拟额度", async () => {
  const config = await loadConfig("config/example.json");
  await assert.rejects(createApp({ ...config, provider: "codex", codex: { ...config.codex, executable: join(tmpdir(), "missing-codex-cli-for-tests") } }).status(), { code: "CODEX_NOT_FOUND" });
});

test("配置和任务路径相对文件解析；非法版本和重复 ID 被拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-scheduler-"));
  try {
    await mkdir(join(dir, "config"));
    const config = { schemaVersion: 1, provider: "mock", pollIntervalMs: 60000, quotaMaxAgeMs: 120000,
      reservePercent: 10, limitId: "codex", tasksFile: "../tasks.json" };
    const configFile = join(dir, "config", "app.json");
    await writeFile(configFile, JSON.stringify(config));
    assert.equal((await loadConfig(configFile)).tasksFile, join(dir, "tasks.json"));
    await writeFile(configFile, JSON.stringify({ ...config, schemaVersion: 2 }));
    await assert.rejects(loadConfig(configFile), { code: "CONFIG_VERSION" });
    const task = { id: "same", name: "Demo", enabled: true, projectDir: ".", promptFile: "prompt.md", priority: 1, session: { mode: "new" } };
    const tasksFile = join(dir, "tasks.json");
    await writeFile(tasksFile, JSON.stringify([task, task]));
    await assert.rejects(loadTasks(tasksFile), { code: "DUPLICATE_TASK" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
