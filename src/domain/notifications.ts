export const noticeKinds = ["task_succeeded", "task_failed", "task_cancelled", "needs_attention", "login_required", "quota_failure", "quota_recovered", "service_failure", "service_recovered", "quota_reset", "timed_missed", "timed_attention", "timed_ready"] as const;
export type NoticeKind = typeof noticeKinds[number];
export type NoticeTarget = "overview" | "runs" | "recovery" | "schedules";
export interface FeedCursor { execution: number; recovery: number; quota: number }
export interface NoticeEvent { key: string; kind: NoticeKind; runId: string | null; target: NoticeTarget; createdAt: string }
export interface DesktopFeed {
  provider: "mock" | "codex";
  scope: string; cursor: FeedCursor; baseline: boolean; pendingAttention: boolean; events: NoticeEvent[];
  monitor: { failures: number; errorCode: string | null } | null;
}
export interface FeedRequest { scope: string | null; cursor: FeedCursor | null }
export interface NotificationCheckpoint {
  scope: string | null; cursor: FeedCursor | null; seen: string[];
  serviceFailures: number; serviceAlerted: boolean; monitorFault: "auth" | "query" | null; cycle: number;
}
export const emptyCheckpoint = (): NotificationCheckpoint => ({ scope: null, cursor: null, seen: [], serviceFailures: 0, serviceAlerted: false, monitorFault: null, cycle: 0 });

/** Only verified feed events can produce task/reset notices. Timer ticks never synthesize a reset. */
export function notificationTransition(previous: NotificationCheckpoint, feed: DesktopFeed | null, now: Date) {
  const next = structuredClone(previous), notices: NoticeEvent[] = [];
  function emit(event: NoticeEvent) { if (!next.seen.includes(event.key)) { next.seen.push(event.key); notices.push(event); } }
  function local(kind: NoticeKind, target: NoticeTarget) {
    emit({ key: `${kind}:${next.scope ?? "local"}:${next.cycle}`, kind, target, runId: null, createdAt: now.toISOString() });
  }
  if (!feed) {
    next.serviceFailures = Math.min(3, next.serviceFailures + 1);
    if (next.serviceFailures >= 3 && !next.serviceAlerted) { next.cycle++; next.serviceAlerted = true; local("service_failure", "overview"); }
  } else {
    if (next.serviceAlerted) local("service_recovered", "overview");
    next.serviceAlerted = false; next.serviceFailures = 0;
    if (next.scope !== feed.scope || feed.baseline) next.monitorFault = null;
    next.scope = feed.scope; next.cursor = feed.cursor;
    for (const event of feed.events) emit(event);
    if (feed.baseline && feed.pendingAttention) emit({ key: `pending:${feed.scope}`, kind: "needs_attention", target: "recovery", runId: null, createdAt: now.toISOString() });
    const monitor = feed.monitor;
    if (monitor?.errorCode === "CODEX_AUTH_REQUIRED" && next.monitorFault !== "auth") {
      next.cycle++; next.monitorFault = "auth"; local("login_required", "overview");
    } else if (monitor?.errorCode && monitor.failures >= 3 && !next.monitorFault) {
      next.cycle++; next.monitorFault = "query"; local("quota_failure", "overview");
    } else if (monitor && monitor.errorCode === null && next.monitorFault) {
      local("quota_recovered", "overview"); next.monitorFault = null;
    }
  }
  next.seen = next.seen.slice(-512);
  return { checkpoint: next, notices };
}

/** Fixed copy contains no task names, prompts, output, email, paths or raw remote errors. */
export const noticeCopy: Record<NoticeKind, { title: string; body: string }> = {
  task_succeeded: { title: "任务已完成", body: "最终结果已保存，点击查看对应运行。" },
  task_failed: { title: "任务执行失败", body: "已有结果已保存，点击检查对应运行。" },
  task_cancelled: { title: "任务已确认取消", body: "终态已保存，点击查看对应运行。" },
  needs_attention: { title: "需要人工核对", body: "请核对已有运行，客户端不会自动批准、解锁或重发。" },
  login_required: { title: "Codex 登录不可用", body: "请检查相同配置下的登录状态，派发不会自动恢复。" },
  quota_failure: { title: "额度查询持续失败", body: "额度状态未知，请检查连接与账户状态。" },
  quota_recovered: { title: "额度查询已恢复", body: "已重新完成查询；是否可用以服务端数据为准。" },
  service_failure: { title: "本地服务连接持续异常", body: "请打开客户端检查后台，不会自动重启或重发任务。" },
  service_recovered: { title: "本地服务连接已恢复", body: "已验证后台连接，派发状态保持原设置。" },
  quota_reset: { title: "已确认额度窗口刷新", body: "完整查询已确认刷新，其他限制仍以当前额度判定为准。" },
  timed_missed: { title: "定时计划已错过", body: "本次实例未启动；请查看计划时间和阻塞原因。" },
  timed_attention: { title: "定时计划需要检查", body: "计划、实际窗口或额度目标需要核对，客户端不会强制重置或重发。" },
  timed_ready: { title: "开始使用时额度已达目标", body: "完整查询达到本次目标；后续用量仍以服务端实时数据为准。" },
};
