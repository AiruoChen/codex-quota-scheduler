import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { readHarnessResult } from "../scripts/lib/acceptance-artifacts.mjs";
import { runAcceptanceCommand } from "../scripts/lib/acceptance-command.mjs";
import { root } from "../scripts/lib/runtime-files.mjs";
import { smokeFailureSummary } from "../scripts/lib/desktop-diagnostics.mjs";

async function localFixture(t, prefix) {
  const local = join(root, ".local");
  await mkdir(local, { recursive: true });
  const directory = await mkdtemp(join(local, prefix));
  assert.equal(resolve(dirname(directory)), resolve(local));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}

test("单测证据必须有正数 TAP tests 和零失败记录", async (t) => {
  const directory = await localFixture(t, "acceptance-command-");
  const command = (body) => [process.execPath, ["-e", body]];
  const valid = command('console.log("TAP version 13\\n# tests 3\\n# fail 0")');
  const result = await runAcceptanceCommand("unit", valid[0], valid[1], join(directory, "valid.log"), { requireTap: true });
  assert.equal(result.count, 3);
  for (const [name, script] of [
    ["missing", 'console.log("completed without TAP")'],
    ["empty", 'console.log("# tests 0\\n# fail 0")'],
    ["failed", 'console.log("# tests 3\\n# fail 1")'],
  ]) {
    const candidate = command(script);
    await assert.rejects(runAcceptanceCommand("unit", candidate[0], candidate[1], join(directory, name + ".log"), { requireTap: true }),
      /ACCEPTANCE_UNIT_TAP_MISSING/);
  }
});

test("超时先向当前步骤发送合作停止信号并拒绝其结果", async (t) => {
  const directory = await localFixture(t, "acceptance-command-");
  const log = join(directory, "slow.log");
  const script = 'const fs=require("node:fs");setInterval(()=>{if(fs.existsSync(process.env.CQS_ACCEPTANCE_STOP_FILE)){console.log("stopped");process.exit(0)}},10)';
  await assert.rejects(runAcceptanceCommand("slow", process.execPath, ["-e", script], log,
    { timeoutMs: 1000, cooperativeStop: true, stopGraceMs: 5000 }), /ACCEPTANCE_SLOW_FAILED/);
  assert.match(await readFile(log, "utf8"), /stopped/);
  await assert.rejects(readFile(log + ".stop"), { code: "ENOENT" });
});

test("桌面与安装失败诊断只接纳固定字段和安全标量", async (t) => {
  const directory = await localFixture(t, "acceptance-command-");
  const diagnostic = { checkpoint: "gui_ready", reason: "UI_NOT_READY", visibility: "visible", focused: false, actual: "private-output", expected: true,
    prompt: "private-task-content" };
  const script = `console.log(JSON.stringify({smokeFailure:${JSON.stringify(diagnostic)}}));process.exit(1)`;
  for (const id of ["desktop", "installer"]) {
    await assert.rejects(runAcceptanceCommand(id, process.execPath, ["-e", script], join(directory, id + ".log")), (error) => {
      assert.deepEqual(error.smokeFailure, { checkpoint: "gui_ready", reason: "UI_NOT_READY", visibility: "visible", focused: false, expected: true });
      assert.equal(JSON.stringify(error.smokeFailure).includes("private"), false);
      return true;
    });
  }
});

test("安装早期失败保留检查点，公开摘要不携带错误原文或字符串断言", async (t) => {
  const directory = await localFixture(t, "acceptance-command-");
  const privateError = Object.assign(new Error("PRIVATE path and prompt"), { code: "ERR_ASSERTION", actual: "PRIVATE", expected: 42 });
  assert.deepEqual(smokeFailureSummary("installer-fresh-install", privateError), {
    checkpoint: "installer-fresh-install", reason: "ASSERTION_FAILED", visibility: "unknown", focused: false, expected: 42 });
  const script = 'console.log(JSON.stringify({smokeCheckpoint:"installer-fresh-install"}));console.error("PRIVATE raw error");process.exit(1)';
  await assert.rejects(runAcceptanceCommand("installer", process.execPath, ["-e", script], join(directory, "early.log")), (error) => {
    assert.deepEqual(error.smokeFailure, { checkpoint: "installer-fresh-install", reason: "SMOKE_CHECK_FAILED", visibility: "unknown", focused: false });
    assert.equal(JSON.stringify(error).includes("PRIVATE"), false); return true;
  });
});

test("仅从 .local 直接子目录读取固定结果，拒绝外部路径与虚假前缀", async (t) => {
  const directory = await localFixture(t, "desktop-acceptance-");
  await writeFile(join(directory, "result.json"), JSON.stringify({ passed: true, count: 1 }));
  assert.deepEqual(await readHarnessResult({ passed: true, artifacts: directory }, "desktop-acceptance-"), { passed: true, count: 1 });
  for (const bad of ["../private", join(directory, "nested"), dirname(directory), directory + "/../other"]) {
    await assert.rejects(readHarnessResult({ passed: true, artifacts: bad }, "desktop-acceptance-"), /ACCEPTANCE_ARTIFACT_PATH_INVALID/);
  }
  await assert.rejects(readHarnessResult({ passed: true, artifacts: directory }, "soak-acceptance-"), /ACCEPTANCE_ARTIFACT_PATH_INVALID/);
  await assert.rejects(readHarnessResult({ passed: false, artifacts: directory }, "desktop-acceptance-"), /ACCEPTANCE_ARTIFACT_PATH_INVALID/);
});
