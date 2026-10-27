import { $, el, empty, button } from "./dom.js";
import { badge, reasons } from "./labels.js";
import type { UiContext } from "./context.js";

export function renderQueue(context: UiContext) {
  const state = context.state(); if (!state) return;
  const scheduler = state.scheduler;
  $("scheduler-badge").textContent = scheduler.paused ? "派发已暂停" : "派发已恢复";
  $("scheduler-badge").className = "badge " + (scheduler.paused ? "warn" : "good");
  $("scheduler-description").textContent = reasons[scheduler.reason ?? ""] ?? "仅串行执行显式入队的持久化版本快照。";
  const owner = state.recovery.owners.find((owner) => owner.kind === "scheduler");
  $("worker-status").textContent = scheduler.worker ? `调度进程记录 · PID ${scheduler.worker.pid}${owner && owner.state !== "alive" ? " · 需要核对" : ""}` : "调度进程未启动";
  $("trigger-mode").textContent = scheduler.worker ? scheduler.worker.trigger === "refresh" ? "确认刷新后触发" : "额度可用时触发" : "启动后仍需手动恢复派发";
  $("queue-items").replaceChildren(...(scheduler.queue.length ? scheduler.queue.map((item) => el("div", { class: "queue-item" }, el("div", {}, el("strong", {}, item.taskId), el("small", {}, `版本 ${item.revision} · 优先级 ${item.priority}`)),
    el("div", { class: "actions" }, badge(item.status), button("查看快照", () => context.openRun(item.runId)), ...(["queued", "waiting_quota"].includes(item.status) ? [button("移除", () => context.act("remove", { id: item.runId }, "已移除尚未领取的队列记录。"), "quiet")] : [])))) : [empty("队列为空。前往任务管理，显式加入版本快照。") ]));
}
