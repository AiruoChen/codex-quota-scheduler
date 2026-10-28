import { createHmac, randomBytes } from "node:crypto";
import type { ExecutionSink, TaskDefinition } from "../../domain/task.js";
import { isRecord } from "../../shared/validation.js";
import { resumeWorkspaceRoots } from "./resume-authorization.js";

const methods = ["initialize", "account/read", "account/rateLimits/read", "configRequirements/read", "model/list", "project/read", "thread/read", "thread/resume", "thread/start", "thread/turns/list", "turn/start", "turn/interrupt", "other"];
const names = ["cliVersion", "cwd", "runtimeWorkspaceRoots", "writableRoots", "threadId", "environmentIds", "environmentCwds", "environmentRoots", "environmentCount", "environmentShapeValid", "sandboxType", "networkAccess", "excludeSlashTmp", "excludeTmpdirEnvVar", "approvalPolicy", "approvalsReviewer", "sandboxExtraFields", "inputCharacters", "inputItems", "rpcCode", "errorCode", "turnPresent", "threadPresent", "accountPresent", "accountType"];
const choices = ["missing", "invalid", "unreported", "unknown", "readOnly", "workspaceWrite", "dangerFullAccess", "externalSandbox", "on-request", "never", "untrusted", "user", "auto_review", "guardian_subagent", "chatgpt", "apiKey", "CODEX_TIMEOUT", "CODEX_CONNECTION_CLOSED", "CODEX_EXITED", "CODEX_START_FAILED", "CODEX_PROTOCOL_ERROR", "EXECUTION_CANCELLED", "CODEX_RPC_ERROR", "CODEX_AUTH_REQUIRED", "CODEX_INCOMPATIBLE", "CODEX_NETWORK_ERROR", "CODEX_CLIENT_ERROR", "STORAGE_WRITE_FAILED"];
export interface TraceField { name: string; value: boolean | number | string | string[] }
export interface SafeExecutionTrace { format: 1; phase: "connected" | "expected" | "request" | "response" | "error"; method: string; requestId: number; offsetMs: number; fields: TraceField[] }
const reference = /^(?:path|thread|environment)-[a-f0-9]{16}$/;

/** Re-project persisted data too; exported reports never trust arbitrary event properties. */
export function readExecutionTrace(value: unknown): SafeExecutionTrace | null {
  if (!isRecord(value) || value.format !== 1 || !["connected", "expected", "request", "response", "error"].includes(String(value.phase))
    || !methods.includes(String(value.method)) || !Number.isSafeInteger(value.requestId) || Number(value.requestId) < 0
    || !Number.isSafeInteger(value.offsetMs) || Number(value.offsetMs) < 0 || !Array.isArray(value.fields)) return null;
  const fields: TraceField[] = [];
  for (const item of value.fields.slice(0, 40)) {
    if (!isRecord(item) || typeof item.name !== "string" || !names.includes(item.name)) continue;
    const v = item.value;
    const allowed = typeof v === "boolean" || typeof v === "number" && Number.isSafeInteger(v)
      || typeof v === "string" && (choices.includes(v) || reference.test(v) || item.name === "cliVersion" && v.length < 81 && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(v))
      || Array.isArray(v) && v.length <= 100 && v.every(ref => typeof ref === "string" && reference.test(ref));
    if (allowed) fields.push({ name: item.name, value: v as TraceField["value"] });
  }
  return { format: 1, phase: value.phase as SafeExecutionTrace["phase"], method: String(value.method), requestId: Number(value.requestId), offsetMs: Number(value.offsetMs), fields };
}

/** Complete control-plane timeline, not message bodies. References correlate only within this run. */
export class ExecutionTrace {
  private readonly key = randomBytes(32);
  private readonly started = performance.now();
  private count = 0;
  constructor(private readonly sink: Pick<ExecutionSink, "event">) {}
  private ref(kind: string, value: unknown): string {
    return `${kind}-${createHmac("sha256", this.key).update(typeof value === "string" ? value : "invalid").digest("hex").slice(0, 16)}`;
  }
  record(phase: SafeExecutionTrace["phase"], method: string, requestId: number, value: unknown): void {
    if (this.count++ >= 256) { if (this.count === 257) this.sink.event("codex_trace_truncated", { limit: 256 }); return; }
    const data = isRecord(value) ? value : {}, thread = isRecord(data.thread) ? data.thread : {};
    const fields: TraceField[] = [];
    const add = (name: string, v: TraceField["value"]) => fields.push({ name, value: v });
    const choice = (v: unknown) => typeof v === "string" && choices.includes(v) ? v : v === undefined ? "missing" : "unknown";
    const bool = (v: unknown) => typeof v === "boolean" ? v : v === undefined ? "missing" : "invalid";
    const paths = (v: unknown): TraceField["value"] => Array.isArray(v) && v.length <= 100 && v.every(p => typeof p === "string") ? v.map(p => this.ref("path", p)) : v === undefined ? "missing" : "invalid";
    if (typeof data.cliVersion === "string") add("cliVersion", data.cliVersion);
    if (typeof (data.cwd ?? thread.cwd) === "string") add("cwd", this.ref("path", data.cwd ?? thread.cwd));
    if (Object.hasOwn(data, "runtimeWorkspaceRoots")) add("runtimeWorkspaceRoots", paths(data.runtimeWorkspaceRoots));
    if (typeof (data.threadId ?? thread.id) === "string") add("threadId", this.ref("thread", data.threadId ?? thread.id));
    if (Object.hasOwn(data, "thread")) add("threadPresent", isRecord(data.thread));
    if (Object.hasOwn(data, "turn")) add("turnPresent", isRecord(data.turn));
    if (Object.hasOwn(data, "account")) { add("accountPresent", isRecord(data.account)); add("accountType", choice(isRecord(data.account) ? data.account.type : undefined)); }
    const selection = Object.hasOwn(data, "environments") ? data.environments : thread.environments;
    if (selection !== undefined) {
      add("environmentCount", selection === null ? "unreported" : Array.isArray(selection) ? selection.length : "invalid");
      if (Array.isArray(selection)) {
        const envs = selection.slice(0, 100).filter(isRecord);
        add("environmentShapeValid", envs.length === selection.length && envs.every(e => typeof e.environmentId === "string" && typeof e.cwd === "string" && Array.isArray(e.runtimeWorkspaceRoots)));
        add("environmentIds", envs.map(e => this.ref("environment", e.environmentId)));
        add("environmentCwds", envs.map(e => this.ref("path", e.cwd)));
        add("environmentRoots", paths(envs.flatMap(e => Array.isArray(e.runtimeWorkspaceRoots) ? e.runtimeWorkspaceRoots : [])));
      }
    }
    const policy = isRecord(data.sandboxPolicy) ? data.sandboxPolicy : isRecord(data.sandbox) ? data.sandbox : null;
    if (policy) {
      add("sandboxType", choice(policy.type)); add("networkAccess", bool(policy.networkAccess));
      add("writableRoots", paths(policy.writableRoots)); add("excludeSlashTmp", bool(policy.excludeSlashTmp)); add("excludeTmpdirEnvVar", bool(policy.excludeTmpdirEnvVar));
      add("sandboxExtraFields", Object.keys(policy).filter(k => !["type", "networkAccess", "writableRoots", "excludeSlashTmp", "excludeTmpdirEnvVar"].includes(k)).length);
    } else if (typeof data.sandbox === "string") add("sandboxType", data.sandbox === "read-only" ? "readOnly" : data.sandbox === "workspace-write" ? "workspaceWrite" : "unknown");
    if (isRecord(data.config)) {
      add("writableRoots", paths(data.config["sandbox_workspace_write.writable_roots"]));
      add("networkAccess", bool(data.config["sandbox_workspace_write.network_access"]));
      add("excludeSlashTmp", bool(data.config["sandbox_workspace_write.exclude_slash_tmp"]));
      add("excludeTmpdirEnvVar", bool(data.config["sandbox_workspace_write.exclude_tmpdir_env_var"]));
    }
    for (const name of ["approvalPolicy", "approvalsReviewer"] as const) if (Object.hasOwn(data, name)) add(name, choice(data[name]));
    if (Array.isArray(data.input)) {
      add("inputItems", data.input.length); add("inputCharacters", data.input.reduce((n, item: unknown) => n + (isRecord(item) && typeof item.text === "string" ? item.text.length : 0), 0));
    }
    if (Number.isSafeInteger(data.rpcCode)) add("rpcCode", Number(data.rpcCode));
    if (Object.hasOwn(data, "code")) add("errorCode", choice(data.code));
    const trace = readExecutionTrace({ format: 1, phase, method: methods.includes(method) ? method : "other", requestId, offsetMs: Math.floor(performance.now() - this.started), fields });
    if (trace) this.sink.event("codex_trace", { ...trace });
  }
  expected(task: TaskDefinition, cliVersion: string): void {
    this.record("expected", "thread/resume", 0, { cliVersion, cwd: task.projectDir, runtimeWorkspaceRoots: resumeWorkspaceRoots(task),
      threadId: task.session.mode === "resume" ? task.session.threadId : undefined, environments: [], approvalPolicy: "on-request", approvalsReviewer: "user",
      sandboxPolicy: { type: task.execution?.sandbox === "workspace-write" ? "workspaceWrite" : "readOnly", networkAccess: false,
        writableRoots: task.environment!.writableRoots, excludeSlashTmp: true, excludeTmpdirEnvVar: true } });
  }
}
