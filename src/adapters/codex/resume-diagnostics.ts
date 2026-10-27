import { AppError } from "../../shared/errors.js";

const reasons = {
  grant_invalid: "本次任务授权无效",
  thread_mismatch: "服务端会话与指定会话不一致",
  approval_policy: "实际审批策略与授权不一致",
  approval_reviewer: "实际审批处理方与授权不一致",
  cwd_mismatch: "实际工作目录与授权不一致",
  paths_unverified: "无法核对权限目录的真实位置",
  sandbox_missing: "服务端没有返回可核验的沙箱",
  runtime_roots: "实际运行根目录与授权不一致",
  environment_unknown: "环境选择未知，且尚未确认本机协议能显式禁用环境访问",
  environment_selected: "服务端仍返回已选择的外部环境",
  network_access: "实际网络权限与授权不一致",
  sandbox_type: "实际沙箱类型与授权不一致",
  temporary_writes: "临时目录写入限制未按授权生效",
  sandbox_fields: "沙箱包含未核验的权限字段",
  writable_roots: "实际可写目录与授权不一致",
  verification_unavailable: "权限核验未能完成，具体原因未知",
} as const;
type Reason = keyof typeof reasons;

export class ResumeAuthorizationMismatch extends AppError {
  constructor(readonly reason: Reason) {
    super("CODEX_AUTHORIZATION_MISMATCH", `${reasons[reason]}（检查项 ${reason}）；未发送指令，请人工核对后重新授权。`);
  }
}

/** Rebuild the fixed diagnostic projection; never retain raw causes, paths or response fields. */
export function resumeMismatchDiagnostic(error: unknown, cliVersion: string, environmentOverrideVerified: boolean) {
  const reason = error instanceof ResumeAuthorizationMismatch && Object.hasOwn(reasons, error.reason) ? error.reason : "verification_unavailable";
  return { format: 1, stage: "resume_authorization", reason,
    cliVersion: cliVersion.length <= 80 && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(cliVersion) ? cliVersion : null,
    environmentOverrideVerified: environmentOverrideVerified === true };
}

export function resumeMismatchMessage(error: unknown): string {
  const reason = error instanceof ResumeAuthorizationMismatch && Object.hasOwn(reasons, error.reason) ? error.reason : "verification_unavailable";
  return new ResumeAuthorizationMismatch(reason).message;
}
