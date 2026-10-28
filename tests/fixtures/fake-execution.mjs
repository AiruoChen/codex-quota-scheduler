import assert from "node:assert/strict";
import { appendFileSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { join } from "node:path";

const value = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const scenario = value("--scenario-file") ? readFileSync(value("--scenario-file"), "utf8").trim() : value("--scenario") ?? "success";
const fixtureTurnId = scenario.startsWith("continuation-") ? "turn-2" : "turn-1";
const trace = value("--trace");
if (process.argv.includes("--version")) { console.log("codex-cli 0.160.0-fixture"); process.exit(0); }
if (process.argv.includes("generate-json-schema")) {
  if (trace) appendFileSync(trace, JSON.stringify({ method: "fixture/schema" }) + "\n");
  const directory = join(value("--out"), "v2"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "TurnStartParams.json"), JSON.stringify({ properties: {
    environments: { type: ["array", "null"], items: { $ref: "#/definitions/TurnEnvironmentParams" },
      description: scenario.endsWith("-unsupported") ? "Unknown semantics" : "Empty disables environment access for this turn." },
  } }));
  process.exit(0);
}
const audit = value("--audit-file");
const record = (event, key) => { if (audit) appendFileSync(audit, JSON.stringify({ event, pid: process.pid, ...(key ? { key } : {}) }) + "\n"); };
record("spawn"); process.on("exit", () => record("exit"));
assert.ok(process.argv.includes("app-server"));
let initialized = false;
let accountReads = 0;
let quotaReads = 0;
let cwd = value("--project") ?? process.cwd();
let pendingApproval = false;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const notification = (method, params) => send({ method, params: { threadId: "thread-1", turnId: fixtureTurnId, ...params } });
const completed = (status) => notification("turn/completed", { turn: { id: fixtureTurnId, status, items: [] } });
const messages = () => {
  notification("item/agentMessage/delta", { itemId: "answer", delta: "partial " });
  notification("item/agentMessage/delta", { turnId: "unrelated-turn", itemId: "wrong", delta: "ignore me" });
  notification("item/completed", { item: { id: "answer", type: "agentMessage", text: "verified reply", phase: "final_answer" } });
  completed("completed");
};
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (trace) appendFileSync(trace, JSON.stringify(message) + "\n");
  const result = (data) => send({ id: message.id, result: data });
  if (!message.method) {
    if (pendingApproval) { assert.equal(message.result.decision, "cancel"); completed("interrupted"); }
    return;
  }
  if (message.method === "initialize") { result({ userAgent: "test" }); return; }
  if (message.method === "initialized") { initialized = true; return; }
  assert.ok(initialized);
  if (message.method === "configRequirements/read") { result({ requirements: scenario === "authorization-denied" ? { allowedSandboxModes: ["read-only"] } : null }); return; }
  if (message.method === "model/list") { result({ data: [{ id: "fixture-ui-id", model: message.params.cursor ? "fixture-model-2" : "fixture-model", displayName: "Fixture", isDefault: true,
    supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"].map(reasoningEffort => ({ reasoningEffort })) }], nextCursor: scenario === "catalog-paged" && !message.params.cursor ? "models-page2" : null }); return; }
  if (message.method === "project/list") { result({ data: [{ id: message.params.cursor ? "official-empty-project" : "official-project-1", name: "Official fixture project", roots: message.params.cursor ? [] : [{ path: cwd }, { path: cwd + "/second" }] }], nextCursor: scenario === "catalog-paged" && !message.params.cursor ? "projects-page2" : null }); return; }
  if (message.method === "project/read") { result({ project: { id: message.params.projectId, name: "Official fixture project", roots: message.params.projectId === "official-empty-project" ? [] : [{ path: cwd }, { path: cwd + "/second" }] } }); return; }
  if (message.method === "thread/list") {
    let threads = [{ id: "named-thread", name: "Named fixture chat", cwd, projectId: "official-project-1" },
      { id: "unassigned-thread", name: "Unassigned fixture chat", cwd, projectId: null }, { id: "unknown-thread", name: null, cwd }];
    if (scenario === "catalog-unassigned") threads = threads.map(thread => ({ ...thread, projectId: null }));
    if (scenario === "catalog-legacy") {
      if (message.params.projectId) threads = [];
      else { result({ data: message.params.cursor ? [{ id: "thread-1", name: "Legacy named chat", cwd, projectId: null }]
        : [{ id: "unassigned-thread", name: "Unassigned chat", cwd, projectId: null }, { id: "unknown-thread", name: "Unknown assignment", cwd, projectId: null }], nextCursor: message.params.cursor ? null : "legacy-page-2" }); return; }
    }
    if (Object.hasOwn(message.params, "projectId")) threads = threads.filter(thread => Object.hasOwn(thread, "projectId") && thread.projectId === message.params.projectId);
    result({ data: threads, nextCursor: null }); return;
  }
  if (message.method === "account/read") {
    accountReads++;
    result({ account: { type: "chatgpt", email: ["unknown-account", "workspace-account"].includes(scenario) ? null
      : scenario === "account-change" && accountReads > 1 ? "changed@example.test" : "user@example.test",
      ...(scenario === "workspace-account" ? { workspaceId: "fixture-workspace" } : {}), planType: "plus" }, requiresOpenaiAuth: true });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    quotaReads++;
    const resetsAt = value("--quota-reset-file") ? Number(readFileSync(value("--quota-reset-file"), "utf8")) : value("--quota-reset") ? Number(value("--quota-reset")) : scenario === "boundary-refresh" && quotaReads > 1 ? 2000003600 : 2000000000;
    result({ rateLimits: { limitId: "codex", primary: { usedPercent: scenario === "quota-wait" || scenario === "quota-wait-after-refresh" && quotaReads > 1 || ["quota-terminal", "quota-terminal-rate"].includes(scenario) && quotaReads > 1 ? 100 : 10,
      windowDurationMins: 300, resetsAt }, secondary: scenario === "missing-weekly" ? null : { usedPercent: 10, windowDurationMins: 10080, resetsAt } } });
    return;
  }
  if (message.method === "thread/read") {
    result({ thread: { id: "thread-1", cwd: scenario === "wrong-project" ? cwd + "/other" : cwd,
      ...(scenario === "catalog-paged" || scenario.startsWith("authorization-") ? { projectId: "official-project-1", name: "Named fixture chat" } : scenario === "catalog-legacy" ? { projectId: null, name: "Legacy named chat" } : {}),
      historyMode: "paginated", ephemeral: false,
      status: { type: ["busy-thread", "continuation-busy"].includes(scenario) ? "active" : "idle" } } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    assert.equal(message.params.approvalPolicy, "on-request");
    assert.equal(message.params.approvalsReviewer, "user");
    assert.ok(["read-only", "workspace-write"].includes(message.params.sandbox));
    if (message.method === "thread/resume" && scenario.startsWith("resume-reject")) {
      const reason = scenario === "resume-reject-missing" ? "no rollout found for thread id thread-1"
        : scenario === "resume-reject-capability" ? "thread/resume requires experimentalApi capability"
        : "unrecognized refusal; network login token timeout are only echoed private words";
      send({ id: message.id, error: { code: -32600, message: reason + " private-debug-secret-must-not-leak https://fixture.invalid/?token=PRIVATE_TOKEN C:/private-fixture-path", data: { prompt: "PRIVATE_RPC_BODY" } } });
      return;
    }
    cwd = message.params.cwd;
    const explicit = !!message.params.config;
    result({ thread: { id: "thread-1", cwd, ...(explicit ? { environments: scenario.startsWith("authorization-null-") ? null : scenario === "authorization-environment-selected" || scenario.startsWith("authorization-selected-") ? [{ environmentId: "fixture-selected", cwd, runtimeWorkspaceRoots: message.params.runtimeWorkspaceRoots ?? [cwd] }] : [] } : {}), ...(Object.hasOwn(message.params, "projectId") ? { projectId: message.params.projectId } : scenario === "catalog-paged" || scenario.startsWith("authorization-") ? { projectId: "official-project-1" } : {}), status: { type: "idle" } }, cwd, model: "fixture-model",
      ...(explicit ? { approvalPolicy: "on-request", approvalsReviewer: "user", runtimeWorkspaceRoots: message.params.runtimeWorkspaceRoots,
        sandbox: scenario === "authorization-mismatch" ? { type: "dangerFullAccess" } : message.params.sandbox === "read-only" ? { type: "readOnly", networkAccess: false }
          : { type: "workspaceWrite", writableRoots: message.params.config["sandbox_workspace_write.writable_roots"], networkAccess: false,
            excludeSlashTmp: message.params.config["sandbox_workspace_write.exclude_slash_tmp"], excludeTmpdirEnvVar: message.params.config["sandbox_workspace_write.exclude_tmpdir_env_var"] } } : {}) });
    return;
  }
  if (message.method === "turn/start") {
    record("submit", createHash("sha256").update(JSON.stringify(message.params.input)).digest("hex"));
    assert.equal(message.params.cwd, cwd);
    assert.equal(message.params.approvalPolicy, "on-request");
    assert.equal(message.params.sandboxPolicy.networkAccess, false);
    if (scenario === "submit-reject") {
      send({ id: message.id, error: { code: -32600, message: "unknown PRIVATE_SUBMISSION_BODY" } }); return;
    }
    if (scenario === "lost-submission") { process.exit(7); }
    if (scenario === "early-complete") { messages(); result({ turn: { id: "turn-1", status: "inProgress" } }); return; }
    if (scenario === "unknown-start-status") { result({ turn: { id: "turn-1", status: "future-status" } }); return; }
    result({ turn: { id: fixtureTurnId, status: "inProgress" } });
    notification("turn/started", { turn: { id: fixtureTurnId, status: "inProgress" } });
    if (scenario === "unknown-terminal-status") { completed("future-status"); return; }
    if (scenario === "large-completed-output" || scenario === "hidden-delta-output") {
      notification("item/completed", { item: { id: "final", type: "agentMessage", text: "final", phase: "final_answer" } });
      for (const id of ["large-1", "large-2", "large-3"]) {
        if (scenario === "large-completed-output") {
          notification("item/completed", { item: { id, type: "agentMessage", text: "x".repeat(600000), phase: "commentary" } });
        } else notification("item/agentMessage/delta", { itemId: id, delta: "x".repeat(600000) });
      }
      completed("completed"); return;
    }
    if (scenario === "failure") {
      notification("error", { error: { message: "private-debug-secret-must-not-leak" }, willRetry: false });
      completed("failed"); return;
    }
    if (["quota-terminal", "quota-terminal-rate", "quota-terminal-no-evidence", "quota-intermediate-success"].includes(scenario)) {
      notification("error", { error: { codexErrorInfo: "usageLimitExceeded", message: "PRIVATE_QUOTA_BODY" }, willRetry: true });
      if (scenario === "quota-intermediate-success") { messages(); return; }
      notification("turn/completed", { turn: { id: "turn-1", status: "failed", items: [], error: {
        codexErrorInfo: scenario === "quota-terminal-rate" ? "rateLimitExceeded" : "usageLimitExceeded", message: "PRIVATE_QUOTA_BODY" } } }); return;
    }
    if (scenario === "approval") {
      pendingApproval = true;
      send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", command: "do not log raw command" } });
      return;
    }
    if (scenario === "input") {
      send({ id: "input-1", method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1" } });
      return;
    }
    if (scenario === "disconnect") { setTimeout(() => process.exit(3), 30); return; }
    if (scenario === "hang" || scenario === "cancel-unconfirmed") {
      notification("item/agentMessage/delta", { itemId: "partial", delta: "work in progress" });
      return;
    }
    setTimeout(messages, scenario === "lifecycle-success" ? 3000 : scenario === "slow-success" ? 1200 : 20);
    return;
  }
  if (message.method === "turn/interrupt") {
    result({});
    if (scenario !== "cancel-unconfirmed") completed("interrupted");
    return;
  }
  if (message.method === "thread/turns/list" || message.method === "thread/items/list") {
    if (scenario === "history-method-missing") { send({ id: message.id, error: { code: -32601, message: "PRIVATE_HISTORY_BODY" } }); return; }
    result({ data: [{ id: scenario === "continuation-conflict" ? "external-turn" : scenario.startsWith("continuation-") ? "turn-1" : "fixture-history", status: "failed", text: "PRIVATE_HISTORY_BODY" }], nextCursor: null }); return;
  }
  send({ id: message.id, error: { code: -32601, message: "Unknown method" } });
});
input.on("close", () => process.exit(0));
