import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopBackend, backendEnvironment } from "../src/desktop/backend.js";
import { desktopOptions, initializeDesktopProfile } from "../src/desktop/profile.js";
import { desktopWebPreferences, isManagementNavigation } from "../src/desktop/security.js";
import { loadConfig } from "../src/config/load.js";
import { contactInstance, readInstance } from "../src/runtime/instance.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "desktop 中文 &-"));
  const options = desktopOptions([], dir);
  await initializeDesktopProfile(options);
  const launch = { executable: process.execPath, entry: resolve("dist/src/desktop/backend-entry.js"), electron: false };
  return { dir, options, backend: new DesktopBackend(options.configPath, launch), launch };
}

test("桌面参数严格校验并解析相对路径，不修改全局配置", () => {
  const options = desktopOptions(["--data-dir", "local data", "--config", "profile.json"], "unused");
  assert.equal(options.dataDir, resolve("local data")); assert.equal(options.configPath, resolve("profile.json"));
  for (const args of [["--unknown"], ["--config"], ["--data-dir", "a", "--data-dir", "b"], ["--config", "bad\0path"]]) {
    assert.throws(() => desktopOptions(args, "unused"), { code: "INVALID_ARGUMENT" });
  }
});

test("首次桌面配置只创建空模拟环境，重复初始化不覆盖配置和任务", async () => {
  const env = await setup();
  try {
    const config = await loadConfig(env.options.configPath);
    assert.equal(config.provider, "mock"); assert.equal(config.storage.databasePath, join(env.dir, "data/state.sqlite"));
    assert.deepEqual(JSON.parse(await readFile(config.tasksFile, "utf8")), []);
    await writeFile(config.tasksFile, "[\"keep-existing-data\"]");
    const before = await readFile(env.options.configPath, "utf8");
    await initializeDesktopProfile(env.options);
    assert.equal(await readFile(env.options.configPath, "utf8"), before);
    assert.equal(await readFile(config.tasksFile, "utf8"), '["keep-existing-data"]');
  } finally { await rm(env.dir, { recursive: true, force: true }); }
});

test("损坏配置、明确指定的缺失配置与孤立数据库不会被初始化覆盖", async () => {
  const env = await setup();
  try {
    await writeFile(env.options.configPath, "broken-json");
    await assert.rejects(initializeDesktopProfile(env.options));
    assert.equal(await readFile(env.options.configPath, "utf8"), "broken-json");
    await assert.rejects(initializeDesktopProfile({ ...env.options, configPath: join(env.dir, "missing.json") }), { code: "CONFIG_NOT_FOUND" });
    await rm(env.options.configPath);
    await mkdir(join(env.dir, "data"));
    await writeFile(join(env.dir, "data/state.sqlite"), "preserve-database");
    await assert.rejects(initializeDesktopProfile(env.options), { code: "CONFIG_MISSING_WITH_DATA" });
    assert.equal(await readFile(join(env.dir, "data/state.sqlite"), "utf8"), "preserve-database");
  } finally { await rm(env.dir, { recursive: true, force: true }); }
});

test("页面不具有 Node 权限，只允许准确管理页和页面内导航", () => {
  assert.equal(desktopWebPreferences.nodeIntegration, false);
  assert.equal(desktopWebPreferences.contextIsolation, true); assert.equal(desktopWebPreferences.sandbox, true);
  const origin = "http://127.0.0.1:8765";
  assert.equal(isManagementNavigation(origin + "/#tasks", origin), true);
  for (const url of ["https://example.test/", origin + "/api/config", origin + "/?redirect=1", "file:///private", "http://user@127.0.0.1:8765/"]) {
    assert.equal(isManagementNavigation(url, origin), false);
  }
});

test("后台子进程继承明确 Node 模式，移除环境注入选项且不污染父环境", () => {
  const original = { NODE_OPTIONS: "--require malicious", NODE_PATH: "private", ELECTRON_RUN_AS_NODE: "bad", PATH: "codex-dir" };
  const child = backendEnvironment(original, true);
  assert.equal(child.ELECTRON_RUN_AS_NODE, "1"); assert.equal(child.NODE_OPTIONS, undefined); assert.equal(child.NODE_PATH, undefined);
  assert.equal(child.PATH, original.PATH); assert.equal(original.ELECTRON_RUN_AS_NODE, "bad");
  assert.equal(backendEnvironment(original, false).ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(backendEnvironment({ node_options: "--require malicious" }, true).node_options, undefined);
});

test("桌面自有后台连接既有 HTTP 保护，安全退出后保留数据库并释放实例", async () => {
  const env = await setup();
  try {
    const connection = await env.backend.start();
    assert.equal(connection.owned, true); assert.match(connection.url, /^http:\/\/127\.0\.0\.1:/);
    assert.equal((await fetch(connection.url + "/api/state")).status, 403);
    const page = await fetch(connection.url);
    const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
    const state = await (await fetch(connection.url + "/api/state", { headers: { cookie } })).json() as { provider: string; scheduler: { paused: boolean } };
    assert.equal(state.provider, "mock"); assert.equal(state.scheduler.paused, true);
    await env.backend.close();
    assert.equal(await readInstance(env.options.configPath), null);
    assert.ok((await readFile(join(env.dir, "data/state.sqlite"))).length > 0);
  } finally { await env.backend.close(); await rm(env.dir, { recursive: true, force: true }); }
});

test("连接外部服务时不获取所有权，关闭连接不会停止该服务", async () => {
  const env = await setup();
  const attached = new DesktopBackend(env.options.configPath, env.launch);
  try {
    const owned = await env.backend.start();
    const external = await attached.start();
    assert.equal(external.owned, false); assert.equal(external.pid, owned.pid);
    await attached.close();
    assert.equal((await fetch(owned.url)).status, 200);
    assert.equal((await readInstance(env.options.configPath))?.pid, owned.pid);
  } finally { await attached.close(); await env.backend.close(); await rm(env.dir, { recursive: true, force: true }); }
});

test("启动期间请求关闭会等待就绪并回收后台，不遗留服务", async () => {
  const env = await setup();
  try {
    const starting = env.backend.start();
    const closing = env.backend.close();
    await starting; await closing;
    assert.equal(await readInstance(env.options.configPath), null);
  } finally { await env.backend.close(); await rm(env.dir, { recursive: true, force: true }); }
});

test("桌面父进程退出使后台通过 IPC 断开执行正常落盘与退出", async () => {
  const env = await setup();
  const parent = spawn(process.execPath, ["--experimental-sqlite", resolve("tests/fixtures/desktop-owner.mjs"), env.options.configPath],
    { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = new Promise<void>((done, reject) => { parent.once("error", reject); parent.once("exit", () => done()); });
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("Desktop test parent timeout")), 10000);
      parent.once("message", () => { clearTimeout(timer); done(); });
      parent.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    parent.disconnect();
    await exited;
    for (let attempt = 0; attempt < 100 && await readInstance(env.options.configPath); attempt++) await delay(50);
    assert.equal(await readInstance(env.options.configPath), null);
    assert.ok((await readFile(join(env.dir, "data/state.sqlite"))).length > 0);
  } finally {
    if (parent.connected) parent.disconnect();
    const record = await readInstance(env.options.configPath);
    if (record) await contactInstance(record, true);
    await exited;
    await rm(env.dir, { recursive: true, force: true });
  }
});

test("已有实例身份变化时禁止状态读取与停止，不向新实例发出请求", async () => {
  const env = await setup();
  const attached = new DesktopBackend(env.options.configPath, env.launch);
  let original = "";
  try {
    await env.backend.start(); await attached.start();
    const path = (await import("../src/runtime/instance.js")).runtimePaths(env.options.configPath).record;
    original = await readFile(path, "utf8");
    const record = JSON.parse(original) as { instance: string };
    await writeFile(path, JSON.stringify({ ...record, instance: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }));
    await assert.rejects(attached.status(), { code: "RUNTIME_INSTANCE_CHANGED" });
    await assert.rejects(attached.close("wait", true), { code: "RUNTIME_INSTANCE_CHANGED" });
    await writeFile(path, original);
  } finally {
    if (original) await writeFile((await import("../src/runtime/instance.js")).runtimePaths(env.options.configPath).record, original);
    await attached.close(); await env.backend.close(); await rm(env.dir, { recursive: true, force: true });
  }
});
