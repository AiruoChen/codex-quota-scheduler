import { api, bootstrap } from "./api.js";
import { $, busy, notice } from "./dom.js";
import type { ManagementState } from "../contracts.js";
import type { UiContext } from "./context.js";
import { StateStore } from "./state.js";
import { route, navigate, renderShell } from "./shell.js";
import { renderOverview, tickOverview } from "./overview.js";
import { queueView } from "./queue.js";
import { recoveryView } from "./recovery.js";
import { tasksView } from "./tasks.js";
import { runsView } from "./runs.js";
import { settingsView } from "./settings.js";

let bootstrapped = false;
let view = route();
const seenJobs = new Map<number, string>();
const context: UiContext = {
  state: () => store.value.data, connected: () => store.value.connected,
  async act(action, data = {}, message) {
    if (!store.value.connected) throw new Error("服务离线，请先重新连接。");
    const result = await api<unknown>("/api/action", { action, ...data });
    if (message) notice(message);
    await refresh(); return result;
  },
  refresh,
  openRun: (id) => runs.open(id),
  async confirmAction(action, id, text) {
    if (!confirm(text)) return;
    const result = await context.act(action, { id, confirm: true }, action === "cancel" ? "已请求取消，终态以运行记录为准。" : "操作已提交，结果见运行记录。") as { runId?: string };
    if (["run", "run-start"].includes(action) && result.runId) await runs.open(result.runId);
    if (runs.isOpen()) await runs.render();
  },
};
const store = new StateStore(async () => {
  if (!bootstrapped) { await bootstrap(); bootstrapped = true; }
  return api<ManagementState>("/api/state");
}, () => {
  renderShell(store.value); renderOverview(store.value, context); queue.render(); recovery.render(); tickOverview(store.now());
  const jobs = store.value.data?.jobs ?? [];
  for (const job of jobs) {
    if (seenJobs.get(job.id) === "running" && job.state !== "running" && !["monitor", "scheduler"].includes(job.kind)) notice(job.state === "failed" ? `后台操作未完成：${job.code}。请检查运行记录。` : "后台操作已结束，请查看运行记录。", job.state === "failed");
  }
  seenJobs.clear(); for (const job of jobs) seenJobs.set(job.id, job.state);
});
const tasks = tasksView(context), runs = runsView(context), settings = settingsView(context);
const queue = queueView(context);
const recovery = recoveryView(context);
async function loadView() {
  if (!store.value.connected) return;
  if (view === "tasks" && !tasks.editing()) await tasks.load();
  if (view === "runs") await runs.load();
  if (view === "recovery") await recovery.load();
  if (runs.isOpen()) await runs.render();
}
async function refresh() { await store.refresh(); await loadView(); }
async function changeView(focus = false) {
  view = route(); navigate(view, focus);
  try { await loadView(); if (view === "settings" && store.value.connected) await settings.load(); }
  catch (error) { notice(error instanceof Error ? error.message : "页面读取失败", true); }
}
window.addEventListener("hashchange", () => { void changeView(true); });
document.querySelector<HTMLAnchorElement>(".skip-link")?.addEventListener("click", (event) => { event.preventDefault(); $("page-title").focus(); });
document.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((node) => { node.onclick = () => $<HTMLDialogElement>(node.dataset.close!).close(); });
document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((node) => { node.onclick = () => { void busy(node, async () => {
  const action = node.dataset.action!;
  if (action === "resume" && !confirm("恢复自动派发？额度满足时将执行显式入队的快照。")) return;
  if (action === "scheduler-stop" && !confirm("停止调度进程？将请求取消当前执行并等待结果保存。")) return;
  await context.act(action, {}, action === "sample" ? "已请求完整查询；以后台返回结果为准。" : "操作已提交。");
}); }; });
$("repair").onclick = () => { void busy($<HTMLButtonElement>("repair"), async () => { if (confirm("显式修复已确认退出的进程与孤立记录？不会重发任务。")) await context.act("repair", { confirm: true }, "已完成本地核对，请继续检查待处理运行。"); }); };
$("reload").onclick = () => { void busy($<HTMLButtonElement>("reload"), async () => { bootstrapped = false; await refresh(); if (view === "settings" && store.value.connected) await settings.load(); }); };
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh().catch((error: unknown) => notice(String(error), true)); });
async function poll() {
  if (!document.hidden) { try { await refresh(); } catch (error) { notice(error instanceof Error ? error.message : "页面读取失败", true); } }
  setTimeout(() => { void poll(); }, 2000);
}
setInterval(() => {
  const query = store.tick(); tickOverview(store.now());
  if (query && store.value.connected && store.value.data?.loop && !store.value.data.closing) {
    void api("/api/action", { action: "sample" }).then(() => store.refresh()).catch(() => store.refresh());
  }
}, 1000);
navigate(view); renderShell(store.value);
await poll();
if (view === "settings" && store.value.connected) await settings.load().catch((error: unknown) => notice(String(error), true));
