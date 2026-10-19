import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const value = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const scenario = value("--scenario") ?? "success";
const trace = value("--trace");
if (process.argv.includes("--version")) { console.log("codex-cli 0.160.0-fixture"); process.exit(0); }
assert.ok(process.argv.includes("app-server"));
let initialized = false;
let accountReads = 0;
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
    result({ account: { type: "chatgpt", email: scenario === "account-change" && accountReads > 1 ? "changed@example.test" : "user@example.test", planType: "plus" }, requiresOpenaiAuth: true });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    result({ rateLimits: { limitId: "codex", primary: { usedPercent: scenario === "quota-wait" ? 100 : 10, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: null } });
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
    assert.equal(message.params.cwd, cwd);
    assert.equal(message.params.approvalPolicy, "on-request");
    assert.equal(message.params.sandboxPolicy.networkAccess, false);
    if (scenario === "lost-submission") { process.exit(7); }
    if (scenario === "early-complete") { messages(); result({ turn: { id: "turn-1", status: "inProgress" } }); return; }
    result({ turn: { id: "turn-1", status: "inProgress" } });
    notification("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
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
    setTimeout(messages, 20);
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
