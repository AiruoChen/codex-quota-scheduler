import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const value = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const scenario = value("--scenario") ?? "success";
const trace = value("--trace");
if (process.argv.includes("--version")) { console.log("codex-cli 0.160.0-fixture"); process.exit(0); }
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
const notification = (method, params) => send({ method, params: { threadId: "thread-1", turnId: "turn-1", ...params } });
const completed = (status) => notification("turn/completed", { turn: { id: "turn-1", status, items: [] } });
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
  if (message.method === "account/read") {
    accountReads++;
    result({ account: { type: "chatgpt", email: ["unknown-account", "workspace-account"].includes(scenario) ? null
      : scenario === "account-change" && accountReads > 1 ? "changed@example.test" : "user@example.test",
      ...(scenario === "workspace-account" ? { workspaceId: "fixture-workspace" } : {}), planType: "plus" }, requiresOpenaiAuth: true });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    quotaReads++;
    const resetsAt = scenario === "boundary-refresh" && quotaReads > 1 ? 2000003600 : 2000000000;
    result({ rateLimits: { limitId: "codex", primary: { usedPercent: scenario === "quota-wait" || scenario === "quota-wait-after-refresh" && quotaReads > 1 ? 100 : 10,
      windowDurationMins: 300, resetsAt }, secondary: scenario === "missing-weekly" ? null : { usedPercent: 10, windowDurationMins: 10080, resetsAt } } });
    return;
  }
  if (message.method === "thread/read") {
    result({ thread: { id: "thread-1", cwd: scenario === "wrong-project" ? cwd + "/other" : cwd,
      status: { type: scenario === "busy-thread" ? "active" : "idle" } } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    assert.equal(message.params.approvalPolicy, "on-request");
    assert.equal(message.params.approvalsReviewer, "user");
    assert.ok(["read-only", "workspace-write"].includes(message.params.sandbox));
    cwd = message.params.cwd;
    result({ thread: { id: "thread-1", cwd, status: { type: "idle" } }, cwd, model: "fixture-model" });
    return;
  }
  if (message.method === "turn/start") {
    record("submit", createHash("sha256").update(JSON.stringify(message.params.input)).digest("hex"));
    assert.equal(message.params.cwd, cwd);
    assert.equal(message.params.approvalPolicy, "on-request");
    assert.equal(message.params.sandboxPolicy.networkAccess, false);
    if (scenario === "lost-submission") { process.exit(7); }
    if (scenario === "early-complete") { messages(); result({ turn: { id: "turn-1", status: "inProgress" } }); return; }
    if (scenario === "unknown-start-status") { result({ turn: { id: "turn-1", status: "future-status" } }); return; }
    result({ turn: { id: "turn-1", status: "inProgress" } });
    notification("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
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
  send({ id: message.id, error: { code: -32601, message: "Unknown method" } });
});
input.on("close", () => process.exit(0));
