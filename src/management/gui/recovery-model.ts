import type { TaskRun } from "../../domain/task.js";

const guidance: Record<string, string> = {
  scheduler_owner_dead: "调度进程已退出。显式修复可释放其进程记录，派发仍保持暂停。",
  scheduler_owner_unknown: "无法确认调度进程是否退出。先核对系统进程，不要释放执行权。",
  execution_owner_dead: "执行进程已退出。先显式修复本地记录，再按原会话与准确回合核对结果。",
  execution_owner_unknown: "无法确认执行进程是否退出。保留执行权，先人工检查。",
  orphan_running: "运行缺少执行权记录。修复后保留待核对，不会重发。",
  submitted_pending: "已有提交证据但缺少终态。只读核对原回合，禁止重复提交。",
  needs_attention: "需要人工核对原会话、审批请求或文件变更；客户端不会自动同意审批。",
};
export function recoveryGuidance(code: string): string { return guidance[code] ?? "保留原始记录，核对来源、账户和准确回合后再操作。"; }
export function outputLabel(run: Pick<TaskRun, "status" | "output">): string {
  if (run.status === "succeeded") return "最终输出";
  return ["running", "needs_attention", "failed", "cancelled"].includes(run.status) && run.output ? "已保存的部分输出" : "执行输出";
}
