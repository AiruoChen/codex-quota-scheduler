import { $, el, empty, time, button } from "./dom.js";
import { badge, reasons, events, labels } from "./labels.js";
import type { UiContext } from "./context.js";
import type { ViewState } from "./state.js";

export function renderOverview(view: ViewState, context: UiContext) {
  const { data: state, connected, expired } = view;
  if (!state) { $("quota-windows").replaceChildren(empty(view.error ? "服务不可用，重新连接后读取额度。" : "正在读取额度，请稍候…")); return; }
  const monitor = state.monitor;
  const live = connected && !expired;
  const status = live ? monitor?.availability.status ?? "unknown" : "unknown";
  $("quota-availability").replaceChildren(badge(status));
  $("quota-caption").textContent = !connected ? "连接已中断，当前额度未知。" : expired ? "读数已到期，等待完整查询；计时结束不代表额度恢复。"
    : reasons[monitor?.availability.reason ?? "unknown_quota"] ?? "等待完整查询";
  $("monitor-status").textContent = !connected ? "监控状态未知" : state.loop === "scheduler" ? "由调度进程监控" : state.loop === "monitor" ? "持续监控中" : "监控已停止";
  $("quota-windows").replaceChildren(...(state.quota.windows.length ? state.quota.windows.map((window) => {
    const duration = window.durationMinutes;
    const name = duration === null ? "时长未知的窗口" : duration % 60 === 0 ? `${duration / 60} 小时窗口` : `${duration} 分钟窗口`;
    const value = live ? window.remainingPercent : null;
    const reset = el("span", { class: "subtle countdown", ...(window.resetsAt ? { "data-reset-at": window.resetsAt } : {}) }, window.missing ? "窗口缺失 · 等待完整查询" : window.resetsAt ? "正在计算时间…" : "服务端未提供刷新时间");
    return el("article", { class: "quota-card" }, el("span", { class: "window-label" }, name), el("span", { class: "badge" }, window.bucketName),
      el("div", { class: "quota-value" }, value === null ? "未知" : `${value}%`, el("small", {}, "剩余")),
      value === null ? el("div", { class: "subtle" }, "等待完整有效查询") : el("progress", { class: "quota-bar", max: 100, value, "aria-label": `${name}剩余额度` }),
      el("span", { class: "subtle" }, `${state.provider === "codex" ? "服务端" : "模拟"}刷新时间 · ${time(window.resetsAt)}`), reset);
  }) : [empty("尚无额度窗口。缺失读数会显示未知，不会被视为额度恢复。") ]));
  $("updated-at").textContent = `最近查询 ${time(monitor?.observedAt)}`;
  $("freshness-status").textContent = !live ? "读数未知" : state.quota.fresh ? "读数有效" : "等待查询";
  $("next-query").textContent = state.loop ? `下次计划查询 ${time(monitor?.nextPollAt)}` : "监控已停止，可手动查询";
  $("quota-error").hidden = !monitor?.errorCode;
  $("quota-error").textContent = `查询错误：${monitor?.errorCode ?? ""}。请检查 CLI、登录状态或连接；保留上次窗口，不恢复派发。`;
  const waiting = state.scheduler.queue.filter((item) => ["queued", "waiting_quota"].includes(item.status)).length;
  $("waiting-count").textContent = String(waiting);
  $("queue-summary").textContent = !connected ? "上次队列状态" : state.scheduler.paused ? "派发已暂停" : "队列已恢复";
  $("attention-count").textContent = String(new Set([...state.scheduler.attention, ...state.recovery.issues.map((issue) => issue.runId ?? issue.code)]).size);
  $("overview-scheduler").textContent = reasons[state.scheduler.reason ?? ""] ?? (state.scheduler.paused ? "队列已暂停，当前任务可继续完成。" : "按优先级串行处理已入队快照。" );
  const current = state.currentRun;
  $("current-run").replaceChildren(...(current ? [el("strong", {}, current.name), el("p", { class: "subtle" }, `${current.taskId} · v${current.revision} · 开始 ${time(current.startedAt)}`), badge(current.status), button("查看当前运行", () => context.openRun(current.id))]
    : [empty("当前没有持有执行权的运行。") ]));
  $("monitor-events").replaceChildren(...(state.events.length ? [...state.events].reverse().slice(0, 6).map((event) => el("div", { class: "event-row" }, el("time", {}, time(event.createdAt)), el("span", {}, events[event.type] ?? event.type), event.data.code ? el("small", {}, event.data.code) : null)) : [empty("尚无监控事件") ]));
  const jobs = state.jobs.filter((job) => !["monitor", "scheduler"].includes(job.kind));
  $("jobs-panel").hidden = !jobs.length;
  $("jobs").replaceChildren(...jobs.slice(-6).reverse().map((job) => el("div", { class: "job-row" }, el("span", {}, `${job.kind} · ${job.code ?? labels[job.detail ?? ""] ?? job.detail ?? ({ running: "处理中", succeeded: "操作已完成", failed: "操作失败" }[job.state])}`), job.runId ? button("查看记录", () => context.openRun(job.runId!)) : "")));
}

export function tickOverview(now: number) {
  document.querySelectorAll<HTMLElement>("[data-reset-at]").forEach((node) => {
    const remaining = Date.parse(node.dataset.resetAt!) - now;
    if (!Number.isFinite(remaining)) { node.textContent = "刷新时间未知"; return; }
    const seconds = Math.max(0, Math.ceil(remaining / 1000));
    node.textContent = seconds === 0 ? "已到服务端时间 · 等待完整查询" : `距服务端时间 ${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分 ${seconds % 60} 秒`;
  });
}
