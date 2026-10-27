import assert from "node:assert/strict";
import test from "node:test";
import { closeWindow } from "../scripts/lib/close-window.mjs";
import { smokeFailureSummary } from "../scripts/lib/desktop-diagnostics.mjs";

test("原生关闭仅发送一次到指定测试进程，使用隐藏异步子进程和有界等待", async () => {
  const calls = [];
  let finish;
  const operation = closeWindow({ async call(method) { calls.push(method); } }, 1234, {
    platform: "win32", systemRoot: "C:/Windows",
    execute(command, args, options) {
      calls.push({ command, args, options });
      return new Promise(resolve => { finish = resolve; });
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0], "Page.bringToFront");
  assert.equal(calls.length, 2);
  const native = calls[1];
  assert.equal(native.options.timeout, 30000);
  assert.equal(native.options.windowsHide, true);
  assert.equal(native.options.maxBuffer, 65536);
  assert.ok(native.args.includes("Hidden"));
  assert.match(native.args.at(-1), /exit \[SchedulerCloseProbe\]::Close\(1234\)/);
  assert.match(native.args.at(-1), /id==owner && IsWindowVisible/);
  assert.match(native.args.at(-1), /if\(count!=1\)return 11/);
  finish(); await operation;
});

test("原生关闭失败有固定分类，不泄露原始命令、stderr 或私密路径，也不重发", async () => {
  for (const [details, reason] of [
    [{ killed: true }, "NATIVE_CLOSE_TIMEOUT"],
    [{ code: "ETIMEDOUT" }, "NATIVE_CLOSE_TIMEOUT"],
    [{ code: 10 }, "NATIVE_CLOSE_WINDOW_MISSING"],
    [{ code: 11 }, "NATIVE_CLOSE_WINDOW_AMBIGUOUS"],
    [{ code: 12 }, "NATIVE_CLOSE_POST_FAILED"],
    [{ code: 1 }, "NATIVE_CLOSE_FAILED"],
  ]) {
    let sends = 0;
    await assert.rejects(closeWindow({ async call() {} }, 1234, {
      platform: "win32", systemRoot: "C:/Windows",
      async execute() {
        sends++;
        throw Object.assign(new Error("PRIVATE_COMMAND_AND_PATH"), details, { stderr: "PRIVATE_STDERR" });
      },
    }), error => {
      assert.equal(error.message, reason);
      assert.equal(error.cause, undefined);
      assert.equal(smokeFailureSummary("tray-native-close", error).reason, reason);
      assert.ok(!JSON.stringify(error).includes("PRIVATE"));
      return true;
    });
    assert.equal(sends, 1);
  }
  assert.equal(smokeFailureSummary("tray-native-close", new Error("NATIVE_CLOSE_PRIVATE")).reason, "SMOKE_CHECK_FAILED");
});

test("无有效 Windows 测试进程时拒绝关闭，不调用原生程序", async () => {
  for (const processId of [0, -1, 1.5, NaN, "1234"]) {
    await assert.rejects(closeWindow({ async call() { throw new Error("Unexpected page action"); } }, processId,
      { platform: "win32", execute() { throw new Error("Unexpected native action"); } }), /NATIVE_CLOSE_UNSUPPORTED/);
  }
});
