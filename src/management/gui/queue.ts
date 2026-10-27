import { $, el, empty, button, setDisabled, time } from "./dom.js";
import { badge, reasons } from "./labels.js";
import type { UiContext } from "./context.js";

export function queueView(context: UiContext) {
  let offset = 0;
  function render() {
  const state = context.state(); if (!state) return;
  const scheduler = state.scheduler;
  $("scheduler-badge").textContent = scheduler.paused ? "派发已暂停" : "派发已恢复";
  $("scheduler-badge").className = "badge " + (scheduler.paused ? "warn" : "good");
  $("scheduler-description").textContent = reasons[scheduler.reason ?? ""] ?? "仅串行执行显式入队的持久化版本快照。";
  const owner = state.recovery.owners.find((owner) => owner.kind === "scheduler");
  $("worker-status").textContent = scheduler.worker ? `调度进程记录 · PID ${scheduler.worker.pid}${owner && owner.state !== "alive" ? " · 需要核对" : ""}` : "调度进程未启动";
  $("trigger-mode").textContent = scheduler.worker ? scheduler.worker.trigger === "refresh" ? "确认刷新后触发" : "额度可用时触发" : "启动后仍需手动恢复派发";
  $("queue-decision").textContent = state.dispatch ? `后台最近判定：${reasons[state.dispatch.reason ?? ""] ?? state.dispatch.reason ?? state.dispatch.event} · ${time(state.dispatch.observedAt)}` : "等待后台判定；按快照优先级降序、相同优先级按入队顺序展示。";
  const search = $<HTMLInputElement>("queue-search").value.trim().toLocaleLowerCase();
  const filter = $<HTMLSelectElement>("queue-filter").value;
  const entries = scheduler.queue.filter((item) => `${item.taskId} ${item.name} ${item.projectDir}`.toLocaleLowerCase().includes(search)
    && (filter === "all" || filter === "active" ? filter === "all" || ["queued", "waiting_quota", "running", "needs_attention"].includes(item.status) : item.status === filter))
    .sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
  if (entries.length && offset >= entries.length) offset = Math.floor((entries.length - 1) / 25) * 25;
  $("queue-count").textContent = `${entries.length} 条快照 · 第 ${Math.floor(offset / 25) + 1} 页`;
  setDisabled($<HTMLButtonElement>("queue-prev"), offset === 0); setDisabled($<HTMLButtonElement>("queue-next"), offset + 25 >= entries.length);
  $("queue-items").replaceChildren(...(entries.length ? entries.slice(offset, offset + 25).map((item) => el("div", { class: "queue-item" }, el("div", {}, el("strong", {}, item.name),
    el("small", {}, `${item.taskId} · 版本 ${item.revision} · 优先级 ${item.priority} · 入队序号 ${item.sequence}`), el("small", {}, item.projectDir), el("small", {}, `入队 ${time(item.createdAt)}${item.enabled === null ? " · 任务已归档，未领取记录将跳过" : !item.enabled ? " · 任务已停用，未领取记录将跳过" : ""}`)),
    el("div", { class: "actions wrap" }, badge(item.status), button("查看快照", () => context.openRun(item.runId)), ...(["queued", "waiting_quota"].includes(item.status) ? [button("移除", async () => { if (confirm("移除尚未领取的快照？历史保留，同一版本不会重新入队。")) await context.act("remove", { id: item.runId }, "已移除尚未领取的队列记录。"); }, "quiet")] : [])))) : [empty("没有符合条件的队列记录。可调整筛选，或前往任务管理入队。") ]));
  }
  for (const id of ["queue-search", "queue-filter"]) $(id).addEventListener(id === "queue-search" ? "input" : "change", () => { offset = 0; render(); });
  $("queue-prev").onclick = () => { offset = Math.max(0, offset - 25); render(); };
  $("queue-next").onclick = () => { offset += 25; render(); };
  return { render };
}
