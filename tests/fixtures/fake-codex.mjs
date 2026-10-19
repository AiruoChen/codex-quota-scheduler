import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const scenario = option("--scenario") ?? "happy";
if (process.argv.includes("--version")) {
  if (scenario === "version-timeout") setInterval(() => {}, 1000);
  else {
    console.log(scenario === "bad-version" ? "unrecognized launcher" : "codex-cli 0.160.0-test.1");
    process.exit(0);
  }
} else {
  if (!process.argv.includes("app-server")) process.exit(9);
  const trace = option("--trace");
  const log = (data) => { if (trace) appendFileSync(trace, JSON.stringify(data) + "\n"); };
  log({ pid: process.pid, home: process.env.CODEX_HOME ?? null });
  process.stderr.write("private-debug-secret-must-not-leak\n");
  if (scenario === "exit-start") process.exit(7);
  if (scenario === "stubborn") setInterval(() => {}, 1000);
  let initialized = false;
  let acknowledged = false;
  const send = (message) => {
    const line = Buffer.from(JSON.stringify(message) + "\n");
    if (scenario === "fragmented") {
      const chinese = line.indexOf(Buffer.from("用户"));
      const split = chinese >= 0 ? chinese + 1 : Math.floor(line.length / 2);
      process.stdout.write(line.subarray(0, split));
      setTimeout(() => process.stdout.write(line.subarray(split)), 5);
    } else process.stdout.write(line);
  };
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (!message.method) { log({ serverReply: message }); return; }
    log({ method: message.method, params: message.params });
    const result = (value) => send({ id: message.id, result: value });
    if (message.method === "initialize") {
      if (scenario === "timeout-init") return;
      if (scenario === "malformed") { process.stdout.write("not JSON\n"); return; }
      if (scenario === "oversized") { process.stdout.write("x".repeat(1024 * 1024 + 1)); return; }
      if (scenario === "response-missing") { send({ id: message.id }); return; }
      initialized = true;
      result(scenario === "bad-init" ? {} : { userAgent: "fixture", platformFamily: "test", platformOs: "test" });
      return;
    }
    if (message.method === "initialized") { acknowledged = initialized; return; }
    if (!initialized || !acknowledged) { send({ id: message.id, error: { code: -32000, message: "Not initialized" } }); return; }
    if (message.method === "account/read") {
      if (scenario === "account-missing") { result({ requiresOpenaiAuth: true }); return; }
      const account = scenario === "account-null" ? null : scenario === "api-key" ? { type: "apiKey" }
        : { type: "chatgpt", email: "用户@example.test", planType: "plus" };
      result({ account, requiresOpenaiAuth: true });
      return;
    }
    if (message.method === "account/rateLimits/read") {
      if (scenario.startsWith("rpc-")) {
        const errors = {
          "rpc-auth": { code: 401, message: "Unauthorized private-debug-secret-must-not-leak" },
          "rpc-network": { code: -32000, message: "fetch failed: private-debug-secret-must-not-leak" },
          "rpc-incompatible": { code: -32601, message: "private-debug-secret-must-not-leak" },
          "rpc-private": { code: -32000, message: "private-debug-secret-must-not-leak" },
        };
        send({ id: message.id, error: errors[scenario] });
        return;
      }
      if (scenario === "rate-missing") { result({}); return; }
      if (scenario === "quota-empty") { result({ rateLimits: null, rateLimitsByLimitId: {} }); return; }
      if (scenario === "interleaved") {
        send({ method: "account/updated", params: { authMode: "chatgpt" } });
        send({ id: 9999, result: { ignored: true } });
        send({ id: "server-request", method: "account/chatgptAuthTokens/refresh", params: {} });
      }
      result({ rateLimitsByLimitId: { codex: {
        primary: { usedPercent: 31, windowDurationMins: scenario === "weekly-only" ? 10080 : 300, resetsAt: 1792454400 },
        secondary: null,
      } } });
      return;
    }
    send({ id: message.id, error: { code: -32601, message: "Unknown method" } });
  });
  input.on("close", () => { if (scenario !== "stubborn") process.exit(0); });
}
