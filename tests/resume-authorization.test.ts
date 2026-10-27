import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config/load.js";
import { CodexCatalog } from "../src/adapters/codex/catalog.js";
import { resolveTaskTarget } from "../src/management/task-target.js";
import { verifyResumedAuthorization } from "../src/adapters/codex/resume-authorization.js";
import { hasResumeAuthorization } from "../src/domain/resume-authorization.js";
import { parseTask } from "../src/tasks/load.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { ManualExecutionService } from "../src/executor/manual-service.js";
import type { TaskDefinition } from "../src/domain/task.js";

async function setup(scenario = "authorization-success") {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "explicit-resume-"))); await mkdir(join(dir, "second"));
  const scenarioFile = join(dir, "scenario"), trace = join(dir, "trace.jsonl"); await writeFile(scenarioFile, scenario);
  const config = await loadConfig("config/codex.example.json"); config.storage.databasePath = join(dir, "state.sqlite");
  config.codex = { ...config.codex, executable: process.execPath, args: [resolve("tests/fixtures/fake-execution.mjs"), "--scenario-file", scenarioFile, "--trace", trace, "--project", dir], requestTimeoutMs: 2000, shutdownTimeoutMs: 200 };
  const catalog = new CodexCatalog(config.codex), found = await catalog.environment("thread-1");
  const target = (writing = false) => ({ mode: "resume", threadId: "thread-1", authorization: { confirmed: true, readAllLocalFiles: true, context: found.authorization!.context, writableRoots: writing ? [dir] : [] } });
  const grant = (input: unknown, sandbox = "read-only") => resolveTaskTarget(config, join(dir, "config.json"), input, found.scope, "fixture-task", sandbox);
  const task = async (writing = false): Promise<TaskDefinition> => ({ id: "fixture-task", name: "Explicit resume", enabled: true, priority: 10, projectDir: dir, promptFile: join(dir, "synthetic.md"),
    session: { mode: "resume", threadId: "thread-1" }, execution: { sandbox: writing ? "workspace-write" : "read-only", timeoutMs: 10000 }, environment: (await grant(target(writing), writing ? "workspace-write" : "read-only")).environment });
  return { dir, trace, scenarioFile, found, target, grant, task, config, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const requests = async (trace: string) => (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });

for (const writing of [false, true]) test(`explicit ${writing ? "write" : "read"} consent persists and resumes exactly the selected chat with controlled policy`, async () => {
  const env = await setup(); let store: SqliteStore | undefined;
  try {
    const task = await env.task(writing); assert.equal(task.environment!.permissionsVerified, false); assert.equal(hasResumeAuthorization(task), true);
    assert.deepEqual(parseTask(task, "."), task);
    assert.deepEqual(await env.grant(env.target(writing), writing ? "workspace-write" : "read-only"), await env.grant(env.target(writing), writing ? "workspace-write" : "read-only"));
    assert.equal((await requests(env.trace)).some(r => ["thread/resume", "turn/start"].includes(r.method ?? "")), false);
    store = new SqliteStore(env.config.storage.databasePath); await store.tasks.create(task, "SYNTHETIC_EXPLICIT_INSTRUCTION");
    const run = await new ManualExecutionService(env.config, store).runTask(task.id, new AbortController().signal);
    assert.equal(run.status, "succeeded", run.error ?? "Expected success"); assert.deepEqual(run.taskSnapshot.environment, task.environment);
    const calls = await requests(env.trace), resumes = calls.filter(r => r.method === "thread/resume"), turns = calls.filter(r => r.method === "turn/start");
    assert.equal(resumes.length, 1); assert.equal(turns.length, 1); assert.equal(resumes[0]!.params!.threadId, "thread-1");
    assert.equal(resumes[0]!.params!.approvalPolicy, "on-request"); assert.equal(resumes[0]!.params!.approvalsReviewer, "user");
    assert.deepEqual(turns[0]!.params!.runtimeWorkspaceRoots, [env.dir]);
    assert.deepEqual(turns[0]!.params!.environments, []);
    assert.equal((turns[0]!.params!.sandboxPolicy as Record<string, unknown>).networkAccess, false);
    assert.equal(store.execution.events(run.id).filter(e => e.type === "resume_authorization_verified").length, 1);
    await store.tasks.update({ ...task, name: "Changed later" }, "CHANGED_LATER", 1);
    assert.equal(run.promptSnapshot, "SYNTHETIC_EXPLICIT_INSTRUCTION"); assert.deepEqual(run.taskSnapshot.environment, task.environment);
  } finally { store?.close(); await env.cleanup(); }
});

test("omitted consent, missing read acknowledgment, stale context and extra writable roots cannot create a grant", async () => {
  const env = await setup();
  try {
    await assert.rejects(env.grant({ mode: "resume", threadId: "thread-1" }), { code: "CODEX_ENVIRONMENT_UNVERIFIED" });
    for (const patch of [{ confirmed: false }, { readAllLocalFiles: false }]) {
      const input = env.target(); Object.assign(input.authorization, patch); await assert.rejects(env.grant(input), { code: "CODEX_AUTHORIZATION_REQUIRED" });
    }
    const stale = env.target(); stale.authorization.context = "f".repeat(64); await assert.rejects(env.grant(stale), { code: "CODEX_AUTHORIZATION_CHANGED" });
    const extra = env.target(); extra.authorization.writableRoots = [resolve(env.dir, "..")]; await assert.rejects(env.grant(extra, "workspace-write"), { code: "PERMISSION_SCOPE_INVALID" });
    await assert.rejects(env.grant(env.target(true)), { code: "PERMISSION_SCOPE_INVALID" });
    const missingCwd = env.target(true); missingCwd.authorization.writableRoots = [join(env.dir, "second")]; await assert.rejects(env.grant(missingCwd, "workspace-write"), { code: "PERMISSION_SCOPE_INVALID" });
    assert.equal((await requests(env.trace)).some(r => ["thread/resume", "turn/start"].includes(r.method ?? "")), false);
  } finally { await env.cleanup(); }
});

test("managed restrictions revoke saved consent before resume and never submit a prompt", async () => {
  const env = await setup(); let store: SqliteStore | undefined;
  try {
    const task = await env.task(true); store = new SqliteStore(env.config.storage.databasePath); await store.tasks.create(task, "SYNTHETIC_ONLY");
    await writeFile(env.scenarioFile, "authorization-denied");
    const run = await new ManualExecutionService(env.config, store).runTask(task.id, new AbortController().signal);
    assert.equal(run.status, "failed"); assert.match(run.error!, /CODEX_AUTHORIZATION_CHANGED/);
    assert.equal((await requests(env.trace)).some(r => ["thread/resume", "turn/start"].includes(r.method ?? "")), false);
  } finally { store?.close(); await env.cleanup(); }
});

test("unexpected effective permissions after resume leave needs_attention without prompt submission or retry", async () => {
  const env = await setup("authorization-mismatch"); let store: SqliteStore | undefined;
  try {
    const task = await env.task(); store = new SqliteStore(env.config.storage.databasePath); await store.tasks.create(task, "SYNTHETIC_ONLY");
    const run = await new ManualExecutionService(env.config, store).runTask(task.id, new AbortController().signal);
    assert.equal(run.status, "needs_attention", run.error ?? "Expected attention"); assert.match(run.error!, /CODEX_AUTHORIZATION_MISMATCH/);
    const calls = await requests(env.trace); assert.equal(calls.filter(r => r.method === "thread/resume").length, 1); assert.equal(calls.some(r => r.method === "turn/start"), false);
  } finally { store?.close(); await env.cleanup(); }
});

test("effective policy validation rejects network, writable, temp and approval expansion", async () => {
  const env = await setup();
  try {
    const task = await env.task(true), response = { cwd: env.dir, approvalPolicy: "on-request", approvalsReviewer: "user", runtimeWorkspaceRoots: [env.dir], thread: { environments: [] as unknown[] },
      sandbox: { type: "workspaceWrite", networkAccess: false, writableRoots: [env.dir], excludeSlashTmp: true, excludeTmpdirEnvVar: true } };
    await verifyResumedAuthorization(response, task);
    for (const mutate of [
      (r: typeof response) => { r.sandbox.networkAccess = true; },
      (r: typeof response) => { r.sandbox.writableRoots.push(join(env.dir, "second")); },
      (r: typeof response) => { r.sandbox.excludeSlashTmp = false; },
      (r: typeof response) => { r.approvalPolicy = "never"; },
      (r: typeof response) => { r.approvalsReviewer = "auto_review"; },
      (r: typeof response) => { r.runtimeWorkspaceRoots.push(join(env.dir, "second")); },
      (r: typeof response) => { r.thread.environments.push({ environmentId: "remote-fixture" }); },
      (r: typeof response) => { (r.thread as { environments: unknown }).environments = null; },
    ]) { const changed = structuredClone(response); mutate(changed); await assert.rejects(verifyResumedAuthorization(changed, task), { code: "CODEX_AUTHORIZATION_MISMATCH" }); }
    const forged = structuredClone(task); forged.environment!.resumeAuthorization!.threadId = "different"; assert.throws(() => parseTask(forged, "."), { code: "INVALID_TASK" });
  } finally { await env.cleanup(); }
});

test("explicit consent does not auto-accept command approvals", async () => {
  const env = await setup("approval"); let store: SqliteStore | undefined;
  try {
    const task = await env.task(); store = new SqliteStore(env.config.storage.databasePath); await store.tasks.create(task, "SYNTHETIC_ONLY");
    const run = await new ManualExecutionService(env.config, store).runTask(task.id, new AbortController().signal);
    assert.equal(run.status, "needs_attention"); assert.match(run.error!, /EXECUTION_REVIEW_REQUIRED/);
    assert.equal((await readFile(env.trace, "utf8")).includes('"decision":"accept"'), false);
  } finally { store?.close(); await env.cleanup(); }
});
