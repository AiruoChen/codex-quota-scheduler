import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { AppServerQuotaProvider } from "../src/adapters/codex/app-server-provider.js";
import { defaultCodexOptions, resolveCodexExecutable, type CodexOptions } from "../src/adapters/codex/launcher.js";
import { loadConfig } from "../src/config/load.js";
import { AppError } from "../src/shared/errors.js";

const now = new Date("2026-10-19T00:00:00Z");
function provider(scenario = "happy", overrides: Partial<CodexOptions> = {}) {
  return new AppServerQuotaProvider({
    ...defaultCodexOptions,
    executable: process.execPath,
    args: [resolve("tests/fixtures/fake-codex.mjs"), "--scenario", scenario],
    requestTimeoutMs: 3000,
    shutdownTimeoutMs: 200,
    ...overrides,
  }, { now: () => now });
}

test("握手后按顺序读取账户和额度，保留来源、版本和未知工作区", async () => {
  const snapshot = await provider().read();
  assert.equal(snapshot.source, "codex");
  assert.equal(snapshot.fetchedAt, now.toISOString());
  assert.equal(snapshot.cli?.version, "0.160.0-test.1");
  assert.equal(snapshot.account?.email, "用户@example.test");
  assert.equal(snapshot.account?.planType, "plus");
  assert.equal(snapshot.account?.workspaceId, null);
  assert.equal(snapshot.buckets[0]?.windows[0]?.remainingPercent, 69);
});

test("跨 UTF-8 字节拆分的 JSON 响应正确组装", async () => {
  const snapshot = await provider("fragmented").read();
  assert.equal(snapshot.account?.email, "用户@example.test");
  assert.equal(snapshot.buckets[0]?.windows[0]?.remainingPercent, 69);
});

test("仅返回周窗口时保留服务端实际窗口，不创建五小时窗口", async () => {
  const snapshot = await provider("weekly-only").read();
  assert.equal(snapshot.buckets[0]?.windows.length, 1);
  assert.equal(snapshot.buckets[0]?.windows[0]?.durationMinutes, 10080);
});

test("空额度响应表示未知，不能伪造为全部可用", async () => {
  const snapshot = await provider("quota-empty").read();
  assert.deepEqual(snapshot.buckets, []);
});

for (const [scenario, code] of [
  ["account-null", "CODEX_AUTH_REQUIRED"],
  ["api-key", "CODEX_AUTH_UNSUPPORTED"],
  ["account-missing", "CODEX_PROTOCOL_ERROR"],
  ["rate-missing", "CODEX_PROTOCOL_ERROR"],
  ["bad-init", "CODEX_INCOMPATIBLE"],
  ["bad-version", "CODEX_INCOMPATIBLE"],
  ["malformed", "CODEX_PROTOCOL_ERROR"],
  ["response-missing", "CODEX_PROTOCOL_ERROR"],
  ["oversized", "CODEX_PROTOCOL_ERROR"],
  ["rpc-auth", "CODEX_AUTH_REQUIRED"],
  ["rpc-network", "CODEX_NETWORK_ERROR"],
  ["rpc-incompatible", "CODEX_INCOMPATIBLE"],
  ["rpc-private", "CODEX_RPC_ERROR"],
] as const) {
  test(`${scenario} 返回 ${code}，不暴露原始错误`, async () => {
    await assert.rejects(provider(scenario).read(), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, code);
      assert.ok(!error.message.includes("private-debug-secret"));
      return true;
    });
  });
}

test("进程提前退出时迅速失败", async () => {
  await assert.rejects(provider("exit-start").read(), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.ok(["CODEX_EXITED", "CODEX_CONNECTION_CLOSED"].includes(error.code));
    return true;
  });
});

for (const scenario of ["timeout-init", "version-timeout"]) {
  test(`${scenario} 有限超时并结束进程`, async () => {
    await assert.rejects(provider(scenario, { requestTimeoutMs: 500 }).read(), { code: "CODEX_TIMEOUT" });
  });
}

test("通知、未知响应 ID 和反向请求不混淆额度响应，结束后回收子进程", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex rpc 中文 &-"));
  try {
    const trace = join(dir, "trace.jsonl");
    const snapshot = await provider("interleaved", {
      args: [resolve("tests/fixtures/fake-codex.mjs"), "--scenario", "interleaved", "--trace", trace],
      home: join(dir, "home"),
    }).read();
    assert.equal(snapshot.source, "codex");
    const events = (await readFile(trace, "utf8")).trim().split("\n").map((line: string) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(events[0]?.home, join(dir, "home"));
    assert.deepEqual(events.filter((event) => event.method).map((event) => event.method), [
      "initialize", "initialized", "account/read", "account/rateLimits/read",
    ]);
    const accountRead = events.find((event) => event.method === "account/read");
    assert.deepEqual(accountRead?.params, { refreshToken: false });
    assert.deepEqual(events.find((event) => event.serverReply)?.serverReply, {
      id: "server-request", error: { code: -32601, message: "Unsupported client request" },
    });
    const pid = events[0]?.pid;
    assert.equal(typeof pid, "number");
    assert.throws(() => process.kill(pid as number, 0));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("不响应 stdin 关闭的子进程会被终止", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-cleanup-test-"));
  try {
    const trace = join(dir, "trace.jsonl");
    await provider("stubborn", {
      args: [resolve("tests/fixtures/fake-codex.mjs"), "--scenario", "stubborn", "--trace", trace],
    }).read();
    const firstLine = (await readFile(trace, "utf8")).split("\n")[0]!;
    const { pid } = JSON.parse(firstLine) as { pid: number };
    assert.throws(() => process.kill(pid, 0));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("配置提供默认连接参数，支持相对路径和自定义 home，拒绝错误类型", async () => {
  const defaults = await loadConfig("config/example.json");
  assert.equal(defaults.codex.executable, "codex");
  assert.equal(defaults.codex.requestTimeoutMs, 15000);
  const dir = await mkdtemp(join(tmpdir(), "codex-config-test-"));
  try {
    const source = JSON.parse(await readFile("config/codex.example.json", "utf8")) as Record<string, unknown>;
    const configFile = join(dir, "app.json");
    await writeFile(configFile, JSON.stringify({ ...source, codex: { executable: "./bin/codex", home: "./home", args: [] } }));
    const config = await loadConfig(configFile);
    assert.equal(config.codex.executable, resolve(dir, "bin/codex"));
    assert.equal(config.codex.home, resolve(dir, "home"));
    for (const codex of [{ args: "bad" }, { args: [12] }, { requestTimeoutMs: 0 }, { shutdownTimeoutMs: -1 }]) {
      await writeFile(configFile, JSON.stringify({ ...source, codex }));
      await assert.rejects(loadConfig(configFile));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("原生可执行文件路径不经过 shell", async () => {
  assert.deepEqual(await resolveCodexExecutable(process.execPath), { executable: process.execPath, args: [] });
});

test("npm 脚本启动器解析到 Node 入口，不执行 shell 文本", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-shim-test-"));
  try {
    const shim = join(dir, "codex.cmd");
    await writeFile(shim, "This shell text must never run");
    await chmod(shim, 0o755);
    await assert.rejects(resolveCodexExecutable(shim), { code: "CODEX_LAUNCHER_UNSUPPORTED" });
    const entry = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    await mkdir(join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    await writeFile(entry, "// fixture only");
    await chmod(entry, 0o755);
    assert.deepEqual(await resolveCodexExecutable(shim), { executable: process.execPath, args: [entry] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("无效版本启动器返回稳定错误，不输出子进程日志", async () => {
  await assert.rejects(provider("happy", { args: [resolve("tests/fixtures/does-not-exist.mjs")] }).read(), { code: "CODEX_START_FAILED" });
});
