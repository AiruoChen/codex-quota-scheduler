import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { StoredTask, TaskRun } from "../src/domain/task.js";

const cli = resolve("dist/src/cli.js");
function run(config: string, ...args: string[]): unknown {
  return JSON.parse(execFileSync(process.execPath, ["--experimental-sqlite", cli, ...args, "--config", config], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
}

async function setup(dir: string): Promise<string> {
  const config = JSON.parse(await readFile("config/example.json", "utf8")) as Record<string, unknown>;
  await writeFile(join(dir, "config.json"), JSON.stringify({ ...config, tasksFile: "tasks.json", storage: { databasePath: "state.sqlite" } }));
  const task = { id: "one", name: "One", enabled: true, projectDir: ".", promptFile: "prompt.md", priority: 10, session: { mode: "new" } };
  await writeFile(join(dir, "tasks.json"), JSON.stringify([task]));
  await writeFile(join(dir, "task.json"), JSON.stringify(task));
  await writeFile(join(dir, "prompt.md"), "original prompt");
  return join(dir, "config.json");
}

test("独立 CLI 进程编辑任务、保存快照、归档、备份及切换备份读取", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli persist 中文 &-"));
  try {
    const config = await setup(dir);
    assert.equal((run(config, "task", "list") as StoredTask[])[0]?.revision, 1);
    const queued = run(config, "runs", "prepare", "one") as TaskRun;
    assert.equal(queued.status, "queued");
    assert.equal(queued.startedAt, null);
    await writeFile(join(dir, "prompt.md"), "new prompt");
    assert.equal((run(config, "task", "update", join(dir, "task.json"), "--revision", "1") as StoredTask).revision, 2);
    assert.equal((run(config, "runs", "show", queued.id) as TaskRun).promptSnapshot, "original prompt");
    assert.equal((run(config, "task", "disable", "one", "--revision", "2") as StoredTask).enabled, false);
    run(config, "task", "delete", "one", "--revision", "3");
    await rm(join(dir, "tasks.json"));
    assert.deepEqual(run(config, "tasks"), []);
    assert.equal((run(config, "task", "history", "one") as unknown[]).length, 3);
    const backup = join(dir, "backup.sqlite");
    run(config, "storage", "backup", backup);
    run(config, "config", "set", "storage.databasePath", backup);
    assert.equal((run(config, "runs", "show", queued.id) as TaskRun).promptSnapshot, "original prompt");
    assert.deepEqual(run(config, "storage", "check"), { ok: true, tasks: 1, runs: 1, versions: 3 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("两个 CLI 并发更新同一任务会报告版本冲突，不静默覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli concurrent-"));
  try {
    const config = await setup(dir);
    run(config, "tasks");
    const update = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, ["--experimental-sqlite", cli, "task", "update", join(dir, "task.json"), "--revision", "1", "--config", config], { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => resolveResult({ code, stdout, stderr }));
    });
    const results = await Promise.all([update(), update()]);
    assert.equal(results.filter((result) => result.code === 0).length, 1);
    assert.ok(results.find((result) => result.code !== 0)?.stderr.includes("TASK_CONFLICT"));
    assert.equal((run(config, "task", "show", "one") as StoredTask).revision, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CLI 配置 init 及 set 在新进程中生效，demo 不污染配置中的数据库", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-config-"));
  try {
    const source = await setup(dir);
    const target = join(dir, "local.json");
    run(target, "config", "init", source);
    run(target, "config", "set", "reservePercent", "30");
    assert.equal((run(target, "config", "show") as { reservePercent: number }).reservePercent, 30);
    assert.equal((run(target, "demo") as { mode: string }).mode, "preview_only");
    await assert.rejects(readFile(join(dir, "state.sqlite")), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
