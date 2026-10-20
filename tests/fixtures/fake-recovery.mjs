import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
if (process.argv.includes("--version")) { console.log("codex-cli 0.163.0-recovery-test"); process.exit(0); }
const scenario = option("--scenario") ?? "completed";
const project = option("--project") ?? process.cwd();
const trace = option("--trace");
const log = value => { if (trace) appendFileSync(trace, JSON.stringify(value) + "\n"); };
log({ pid: process.pid });
let reads = 0; let pages = 0;
const turn = () => ({ id: "turn-target", status: scenario === "active-turn" ? "inProgress" : ["failed", "interrupted"].includes(scenario) ? scenario : scenario === "status-unknown" ? "unknown" : "completed",
  itemsView: scenario === "summary" ? "summary" : "full", completedAt: 1792537200,
  items: [{ type: "reasoning", id: "reasoning", text: "must not save reasoning" },
    { type: "agentMessage", id: "commentary", text: "progress", phase: "commentary" },
    { type: "agentMessage", id: "answer", text: "recovered reply Bearer private-token-value sk-12345678901234567890", phase: "final_answer" }] });
const input = createInterface({ input: process.stdin });
input.on("line", line => {
  const request = JSON.parse(line); log(request);
  assert.ok(["initialize", "initialized", "account/read", "thread/read", "thread/turns/list", "thread/items/list"].includes(request.method), "Recovery must never mutate or start a remote thread");
  const result = value => process.stdout.write(JSON.stringify({ id: request.id, result: value }) + "\n");
  const error = (code, message) => process.stdout.write(JSON.stringify({ id: request.id, error: { code, message } }) + "\n");
  if (request.method === "initialize") { result({ userAgent: "test" }); return; }
  if (request.method === "initialized") return;
  if (request.method === "account/read") {
    reads++; result({ account: { type: "chatgpt", email: scenario === "account-mismatch" || scenario === "account-change" && reads > 1 ? "other@example.test" : "user@example.test", planType: "plus" } }); return;
  }
  if (request.method === "thread/read") {
    result({ thread: { id: scenario === "thread-mismatch" ? "other-thread" : "thread-target", cwd: scenario === "project-mismatch" ? dirname(project) : project,
      status: { type: scenario === "active-thread" ? "active" : "notLoaded" }, turns: request.params.includeTurns ? [turn()] : [] } }); return;
  }
  if (request.method === "thread/items/list") {
    assert.equal(request.params.turnId, "turn-target");
    const selected = scenario === "items-paging" ? request.params.cursor ? turn().items.slice(2) : turn().items.slice(0, 2) : turn().items;
    result({ data: selected.map(item => ({ turnId: scenario === "items-scope" ? "other-turn" : "turn-target", item })), nextCursor: scenario === "items-paging" && !request.params.cursor ? "items-next" : null }); return;
  }
  pages++;
  if (scenario === "legacy") { error(-32601, "Unknown method"); return; }
  if (scenario === "private-error") { error(-32000, "private-debug-secret"); return; }
  if (scenario === "disconnect") { process.exit(7); }
  if (scenario === "timeout") return;
  if (scenario === "cursor-loop" || scenario === "page-limit") { result({ data: [], nextCursor: scenario === "cursor-loop" ? "same" : String(pages) }); return; }
  if (scenario === "not-found") { result({ data: [{ ...turn(), id: "unrelated-turn" }], nextCursor: null }); return; }
  if (scenario === "paging" && !request.params.cursor) { result({ data: [{ ...turn(), id: "unrelated-turn" }], nextCursor: "second" }); return; }
  assert.equal(request.params.itemsView, "notLoaded");
  result({ data: [scenario === "summary" ? turn() : { ...turn(), items: [], itemsView: "notLoaded" }], nextCursor: null });
});
input.on("close", () => process.exit(0));
