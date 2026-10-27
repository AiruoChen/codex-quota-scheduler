import type { ResumeAuthorization } from "./catalog.js";
import type { TaskDefinition } from "./task.js";

export function isResumeAuthorization(value: unknown): value is ResumeAuthorization {
  if (!value || typeof value !== "object") return false;
  const grant = value as Record<string, unknown>;
  return grant.version === 1 && typeof grant.threadId === "string" && grant.threadId.length > 0
    && typeof grant.context === "string" && /^[a-f0-9]{64}$/.test(grant.context)
    && typeof grant.cliVersion === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(grant.cliVersion)
    && ["read-only", "workspace-write"].includes(String(grant.sandbox)) && grant.readScope === "local-files"
    && grant.networkAccess === false && grant.approvalPolicy === "on-request" && grant.approvalsReviewer === "user";
}

/** An explicit grant is independent of the still-unknown permissions inherited from a native chat. */
export function hasResumeAuthorization(task: TaskDefinition): boolean {
  const env = task.environment, grant = env?.resumeAuthorization;
  return !!env && isResumeAuthorization(grant) && env.mode === "resume" && task.session.mode === "resume"
    && grant.threadId === task.session.threadId && env.cwd === task.projectDir
    && grant.sandbox === (task.execution?.sandbox ?? "read-only")
    && (grant.sandbox === "read-only" ? env.writableRoots.length === 0 : env.writableRoots.includes(env.cwd));
}
