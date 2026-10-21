import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { claimInstance, readInstance, recoverInstance, runtimePaths } from "../src/runtime/instance.js";

const cli = resolve("dist/src/cli.js");
function command(configPath: string, ...args: string[]) {
  return JSON.parse(execFileSync(process.execPath, ["--experimental-sqlite", cli, ...args, "--config", configPath],
    { encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"], timeout: 20000 })) as Record<string, unknown>;
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "runtime 中文 &-"));
  const configPath = join(dir, "config/local.json");
  await mkdir(join(dir, "config"));
  await writeFile(join(dir, "tasks.json"), "[]");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, provider: "mock", pollIntervalMs: 1000, quotaMaxAgeMs: 10000,
    reservePercent: 10, limitId: "codex", tasksFile: "../tasks.json", storage: { databasePath: "../state.sqlite" } }));
  return { dir, configPath };
}

test("后台 CLI 可重复查询与启动，验证实例后停止；重启保留数据库和暂停状态", async () => {
  const env = await setup();
  try {
    assert.equal(command(env.configPath, "service", "status").state, "stopped");
    const first = command(env.configPath, "service", "start", "--port", "0");
    assert.equal(first.running, true);
    assert.match(String(first.url), /^http:\/\/127\.0\.0\.1:/);
    assert.equal(command(env.configPath, "service", "status").state, "ready");
    const second = command(env.configPath, "service", "start", "--port", "0");
    assert.equal(second.pid, first.pid);
    const root = await fetch(String(first.url));
    assert.equal(root.status, 200);
    const cookie = root.headers.get("set-cookie")!.split(";")[0]!;
    const state = await (await fetch(first.url + "/api/state", { headers: { cookie } })).json() as { loop: string; scheduler: { paused: boolean; worker: null } };
    assert.equal(state.loop, "monitor"); assert.equal(state.scheduler.paused, true); assert.equal(state.scheduler.worker, null);
    assert.equal(command(env.configPath, "service", "stop").stopped, true);
    assert.equal(command(env.configPath, "service", "status").state, "stopped");
    assert.match(String(command(env.configPath, "service", "logs").text), /runtime_stopped/);
    const restarted = command(env.configPath, "service", "start", "--port", "0");
    assert.equal(restarted.running, true);
    assert.equal(command(env.configPath, "scheduler", "status").paused, true);
    assert.equal(command(env.configPath, "service", "stop").stopped, true);
    assert.ok((await readFile(join(env.dir, "state.sqlite"))).length > 0);
  } finally {
    try { command(env.configPath, "service", "stop"); } finally { await rm(env.dir, { recursive: true, force: true }); }
  }
});

test("运行记录互斥且凭据不出现在 status；存活进程不能通过 recover 解锁", async () => {
  const env = await setup();
  try {
    const lease = await claimInstance(env.configPath);
    try {
      await assert.rejects(claimInstance(env.configPath), { code: "RUNTIME_BUSY" });
      await assert.rejects(recoverInstance(env.configPath), { code: "RUNTIME_BUSY" });
      const status = command(env.configPath, "service", "status");
      assert.equal(status.state, "starting");
      assert.ok(!JSON.stringify(status).includes(lease.record.token));
      await lease.ready("http://127.0.0.1:8765");
      assert.equal((await readInstance(env.configPath))?.url, "http://127.0.0.1:8765");
      await lease.stopping();
      assert.equal(command(env.configPath, "service", "status").state, "stopping");
    } finally { await lease.release(); }
    assert.equal(await readInstance(env.configPath), null);
  } finally { await rm(env.dir, { recursive: true, force: true }); }
});

test("损坏的运行记录保留并报错，不会自动创建空状态覆盖", async () => {
  const env = await setup();
  try {
    const path = runtimePaths(env.configPath).record;
    await mkdir(runtimePaths(env.configPath).directory, { recursive: true });
    await writeFile(path, "broken-record");
    await assert.rejects(readInstance(env.configPath), { code: "RUNTIME_RECORD_INVALID" });
    await assert.rejects(recoverInstance(env.configPath), { code: "RUNTIME_RECORD_INVALID" });
    await assert.rejects(claimInstance(env.configPath), { code: "RUNTIME_BUSY" });
    assert.equal(await readFile(path, "utf8"), "broken-record");
  } finally { await rm(env.dir, { recursive: true, force: true }); }
});

test("显式恢复只删除已退出服务的记录，不触碰数据库", async () => {
  const env = await setup();
  try {
    const lease = await claimInstance(env.configPath);
    const exitedPid = Number(execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim());
    await writeFile(runtimePaths(env.configPath).record, JSON.stringify({ ...lease.record, pid: exitedPid }));
    await writeFile(join(env.dir, "state.sqlite"), "database-must-not-change");
    assert.equal((await recoverInstance(env.configPath)).recovered, true);
    assert.equal(await readFile(join(env.dir, "state.sqlite"), "utf8"), "database-must-not-change");
    assert.equal(await readInstance(env.configPath), null);
  } finally { await rm(env.dir, { recursive: true, force: true }); }
});

test("端口占用启动失败时清理自己的服务记录，不影响正在运行的实例", async () => {
  const first = await setup(); const second = await setup();
  try {
    const started = command(first.configPath, "service", "start", "--port", "0");
    const port = new URL(String(started.url)).port;
    assert.throws(() => command(second.configPath, "service", "start", "--port", port));
    assert.equal(await readInstance(second.configPath), null);
    assert.equal(command(first.configPath, "service", "status").state, "ready");
  } finally {
    command(first.configPath, "service", "stop");
    await rm(first.dir, { recursive: true, force: true }); await rm(second.dir, { recursive: true, force: true });
  }
});

test("便携包装只包含运行所需文件，无运行依赖；在其他工作目录运行 demo 和 UI", async () => {
  execFileSync(process.execPath, ["scripts/package.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
  const packaged = resolve(".release/codex-quota-scheduler");
  const files = (await readdir(packaged, { recursive: true })).map((file) => file.replaceAll("\\", "/"));
  assert.ok(files.includes("dist/src/management/public/index.html"));
  assert.ok(!files.some((file) => /(^|\/)(node_modules|\.local|\.runtime|\.git)(\/|$)|local\.json|\.sqlite|\.log$/.test(file)));
  const metadata = JSON.parse(await readFile(join(packaged, "package.json"), "utf8")) as { dependencies?: unknown; devDependencies?: unknown };
  assert.equal(metadata.dependencies, undefined); assert.equal(metadata.devDependencies, undefined);
  const guarded = join(packaged, "config/local.json");
  await writeFile(guarded, "package-guard-sentinel");
  try {
    assert.throws(() => execFileSync(process.execPath, ["scripts/package.mjs"], { stdio: ["pipe", "pipe", "pipe"] }));
    assert.equal(await readFile(guarded, "utf8"), "package-guard-sentinel");
  } finally { await rm(guarded); }
  const env = await setup();
  const entry = join(packaged, "dist/src/cli.js");
  try {
    const output = execFileSync(process.execPath, ["--experimental-sqlite", entry, "demo", "--config", join(packaged, "config/example.json")], { cwd: env.dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    assert.equal((JSON.parse(output) as { mode: string }).mode, "preview_only");
    const started = JSON.parse(execFileSync(process.execPath, ["--experimental-sqlite", entry, "service", "start", "--config", env.configPath, "--port", "0"], { cwd: env.dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 20000 })) as { url: string };
    assert.equal((await fetch(started.url)).status, 200);
    assert.equal((await fetch(started.url + "/app.js")).status, 200);
    assert.equal(command(env.configPath, "service", "stop").stopped, true);
  } finally {
    try { command(env.configPath, "service", "stop"); } finally { await rm(env.dir, { recursive: true, force: true }); }
  }
});
