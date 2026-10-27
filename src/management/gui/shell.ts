import { $, setDisabled } from "./dom.js";
import type { ViewState } from "./state.js";
export const titles = { overview: "运行概览", tasks: "任务管理", queue: "调度队列", runs: "运行记录", recovery: "异常与恢复", settings: "设置与帮助" };
export type View = keyof typeof titles;
export function route(hash = location.hash): View { const key = hash.slice(1); return Object.hasOwn(titles, key) ? key as View : "overview"; }
export function navigate(view: View, focus = false) {
  for (const [id, title] of Object.entries(titles)) {
    $(id).hidden = id !== view;
    const link = document.querySelector<HTMLAnchorElement>(`[data-view="${id}"]`)!;
    link.classList.toggle("active", id === view);
    if (id === view) { link.setAttribute("aria-current", "page"); $("page-title").textContent = title; $("breadcrumb").textContent = title; }
    else link.removeAttribute("aria-current");
  }
  if (focus) $("page-title").focus({ preventScroll: true });
}
export function renderShell({ data, connected, expired, error }: ViewState) {
  $("source").textContent = !data ? "来源待确认" : data.provider === "codex" ? "真实账户 · CODEX" : "模拟模式 · MOCK";
  $("source").className = "badge " + (data?.provider === "mock" ? "warn" : "");
  $("account-status").textContent = data?.quota.account ?? "账户待确认";
  $("service-status").textContent = !data ? "正在连接" : !connected ? "服务离线" : data.closing ? "正在停止" : "服务已连接";
  $("service-status").className = "badge " + (connected && !data?.closing ? "good" : "warn");
  $("connection").hidden = connected || !error;
  $("connection").textContent = `连接中断，额度未知；其他内容为上次状态。${error ?? ""}。可点击“重新连接”重试。`;
  $("footer-status").textContent = !data ? "正在连接本地服务" : `${connected ? expired ? "读数已到期 · 等待完整查询" : "本地服务已连接" : "离线 · 上次状态"} · 最近连接 ${new Date(data.now).toLocaleTimeString("zh-CN", { hour12: false })}`;
  $("mock-notice").hidden = data?.provider !== "mock";
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((node) => {
    const action = node.dataset.action!;
    setDisabled(node, !connected || !!data?.closing || (["resume", "scheduler-start"].includes(action) && data?.provider !== "codex")
      || (action === "resume" && data?.loop !== "scheduler") || (action === "monitor-start" && data?.loop === "scheduler")
      || (action === "monitor-stop" && data?.loop !== "monitor"));
  });
}
