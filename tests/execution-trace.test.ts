import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionSink } from "../src/domain/task.js";
import { ExecutionTrace, readExecutionTrace } from "../src/adapters/codex/execution-trace.js";
import { runDiagnostics } from "../src/management/run-diagnostics.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { resolve, join, dirname } from "node:path";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { connectCodex } from "../src/adapters/codex/session.js";
import { defaultCodexOptions } from "../src/adapters/codex/launcher.js";

test("详细请求响应保留权限结构和对照代号，移除正文、路径、凭据及未知字段", async () => {
  const events: { sequence: number; runId: string; createdAt: string; type: string; data: Record<string, unknown> }[] = [];
  const sink: Pick<ExecutionSink, "event"> = { event(type, data) { events.push({ sequence: events.length + 1, runId: "fixture", createdAt: new Date().toISOString(), type, data }); } };
  const trace = new ExecutionTrace(sink), path = "C:\\PRIVATE_PERSON\\PRIVATE_PROJECT", threadId = "PRIVATE_THREAD";
  trace.record("request", "thread/resume", 2, { cwd: path, threadId, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", accessToken: "PRIVATE_CREDENTIAL" });
  trace.record("response", "thread/resume", 2, { cwd: path, thread: { id: threadId, environments: [{ environmentId: "PRIVATE_ENV", cwd: path, runtimeWorkspaceRoots: [path] }] }, sandbox: { type: "workspaceWrite", networkAccess: false, writableRoots: [path], excludeSlashTmp: true, excludeTmpdirEnvVar: true } });
  trace.record("request", "turn/start", 3, { cwd: path, input: [{ type: "text", text: "PRIVATE_PROMPT" }], environments: [] });
  const serialized = JSON.stringify(events);
  for (const privateText of ["PRIVATE_PERSON", "PRIVATE_PROJECT", "PRIVATE_THREAD", "PRIVATE_CREDENTIAL", "PRIVATE_ENV", "PRIVATE_PROMPT"]) assert.ok(!serialized.includes(privateText));
  const records = events.map(e => readExecutionTrace(e.data)!);
  assert.equal(records[0]!.fields.find(f => f.name === "cwd")!.value, records[1]!.fields.find(f => f.name === "cwd")!.value);
  assert.equal(records[1]!.fields.find(f => f.name === "sandboxType")!.value, "workspaceWrite");
  assert.equal(records[2]!.fields.find(f => f.name === "environmentCount")!.value, 0);
  assert.equal(records[2]!.fields.find(f => f.name === "inputCharacters")!.value, 14);
  const store = new SqliteStore(":memory:");
  try {
    await store.tasks.create({ id: "fixture", name: "PRIVATE_TASK", enabled: true, priority: 1, projectDir: resolve(".local/PRIVATE_PATH"), promptFile: resolve(".local/PRIVATE_FILE"), session: { mode: "new" } }, "PRIVATE_BODY");
    const run = await store.runs.create("fixture"), report = runDiagnostics(run, events, new Date(), false, false);
    assert.equal(report.timelineAvailable, true); assert.equal(report.canReconcile, false); assert.equal(report.evidence.submissionStarted, false);
    assert.ok(!JSON.stringify(report).includes("PRIVATE"));
    assert.equal(runDiagnostics(run, [], new Date(), false, false).timelineAvailable, false);
  } finally { store.close(); }
});

test("诊断再导出重新校验字段，截断有明确标志", () => {
  assert.equal(readExecutionTrace({ format: 1, phase: "PRIVATE_PHASE", method: "other", requestId: 1, offsetMs: 1, fields: [] }), null);
  const projected = readExecutionTrace({ format: 1, phase: "error", method: "thread/resume", requestId: 1, offsetMs: 1,
    fields: [{ name: "cwd", value: "PRIVATE_PATH" }, { name: "prompt", value: "PRIVATE_BODY" }, { name: "rpcCode", value: -32600 }], raw: "PRIVATE_ERROR" });
  assert.deepEqual(projected!.fields, [{ name: "rpcCode", value: -32600 }]);
  const seen: string[] = [], trace = new ExecutionTrace({ event(type) { seen.push(type); } });
  for (let i = 0; i < 300; i++) trace.record("request", "account/read", i, {});
  assert.equal(seen.filter(x => x === "codex_trace").length, 256); assert.equal(seen.filter(x => x === "codex_trace_truncated").length, 1);
});

test("请求前诊断落盘失败时停止，不发送该请求且不泄露观察器原始异常", async () => {
  const root = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(root, "quota-trace-write-"))), tracePath = join(directory, "trace.jsonl");
  const { client } = await connectCodex({ ...defaultCodexOptions, executable: process.execPath,
    args: [resolve("tests/fixtures/fake-codex.mjs"), "--trace", tracePath], requestTimeoutMs: 3000, shutdownTimeoutMs: 300 });
  try {
    client.onObservation(() => { throw new Error("PRIVATE_OBSERVER_FAILURE"); });
    await assert.rejects(client.request("account/rateLimits/read"), error => {
      assert.equal((error as { code: string }).code, "STORAGE_WRITE_FAILED"); assert.ok(!(error as Error).message.includes("PRIVATE")); return true;
    });
    await client.close();
    assert.ok(!(await readFile(tracePath, "utf8")).includes('"method":"account/rateLimits/read"'));
  } finally { await client.close(); assert.equal(dirname(directory), root); await rm(directory, { recursive: true, force: true }); }
});
