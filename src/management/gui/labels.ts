import { el } from "./dom.js";
export const labels: Record<string, string> = { queued: "已排队", waiting_quota: "等待额度", running: "执行中", succeeded: "已完成", failed: "失败", needs_attention: "待人工核对", cancelled: "已取消", available: "额度可用", blocked: "额度不足", unknown: "额度未知", paused: "已暂停" };
export const reasons: Record<string, string> = { management_started: "服务启动后保持暂停", worker_started: "等待手动恢复队列", user_paused: "已手动暂停", not_enabled: "尚未启用自动队列", needs_attention: "存在待人工核对的运行", worker_stopping: "调度进程正在停止", runtime_stopping: "服务正在停止", scheduler_error: "调度异常，请检查运行记录", quota_available: "所有相关窗口均满足当前阈值", reserve_reached: "已达到保留额度阈值", quota_exhausted: "相关窗口额度已耗尽", unknown_quota: "缺少完整有效的额度信息", stale_quota: "读数已过期，等待完整查询", read_failed: "查询失败，等待重试", identity_unknown: "账户身份未知", missing_window: "缺少额度窗口" };
export const events: Record<string, string> = { baseline: "已建立监控基线", identity_changed: "账户身份变化", clock_changed: "检测到时钟变化", quota_reset: "已确认额度窗口刷新", availability_changed: "额度可用状态变化", read_error: "额度查询失败", read_recovered: "额度查询已恢复" };
export function badge(status: string) {
  return el("span", { class: `badge ${["available", "succeeded"].includes(status) ? "good" : ["failed", "needs_attention", "blocked"].includes(status) ? "bad" : "warn"}` }, labels[status] ?? status);
}
Object.assign(reasons, { paused: "派发已暂停", busy: "手动或自动执行已持有执行权", requires_real_quota: "需要真实额度，模拟来源不派发", awaiting_refresh: "等待完整查询确认的新刷新事件", empty_queue: "没有可领取的快照", snapshot_changed: "额度检查点已变化，等待下次完整查询", worker_recovered: "调度记录修复后保持暂停" });
Object.assign(reasons, { attention_removed: "已移除待核对记录，等待手动恢复派发" });
