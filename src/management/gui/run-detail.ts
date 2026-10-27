import type { RunDetail } from "../contracts.js";
import { $, el, time, button, notice } from "./dom.js";
import { badge } from "./labels.js";
import { realButton, type UiContext } from "./context.js";
import { copyText } from "./clipboard.js";
import { outputLabel } from "./recovery-model.js";

export function runDetails(context: UiContext) {
  let current: RunDetail | null = null, deferred: RunDetail | null = null, serialized = "";
  const selected = () => {
    const selection = document.getSelection();
    return !!selection && !selection.isCollapsed && ($("run-detail").contains(selection.anchorNode) || $("run-detail").contains(selection.focusNode));
  };
  function reset() { current = null; deferred = null; serialized = ""; $("run-detail").replaceChildren(el("p", { class: "hint" }, "正在读取此记录…")); $("run-update-hint").textContent = ""; }
  function draw(detail: RunDetail) {
    const text = JSON.stringify(detail); if (serialized === text) return;
    if (current?.run.id === detail.run.id && selected()) { deferred = detail; $("run-update-hint").textContent = "有新状态；结束文本选择后更新，当前阅读内容保持不变。"; return; }
    current = detail; deferred = null; serialized = text; $("run-update-hint").textContent = "";
    const dialog = $<HTMLDialogElement>("run-dialog"), scroll = dialog.scrollTop;
    const oldOutput = document.getElementById("run-output"), outputTop = oldOutput?.scrollTop ?? 0, outputLeft = oldOutput?.scrollLeft ?? 0;
    const expanded = Array.from(document.querySelectorAll<HTMLDetailsElement>("#run-detail details")).map((node) => node.open);
    const focused = document.activeElement instanceof HTMLElement && $("run-detail").contains(document.activeElement) ? document.activeElement.dataset.runAction : undefined;
    const run = detail.run;
    $("run-title").textContent = run.taskSnapshot.name;
    const fields = { "运行 ID": run.id, "任务版本": `v${run.taskRevision}`, "项目目录": run.taskSnapshot.projectDir,
      "权限": run.taskSnapshot.execution?.sandbox === "workspace-write" ? "允许修改项目目录" : "只读",
      "开始时间": time(run.startedAt), "完成时间": time(run.completedAt), "原始来源": detail.origin ? `Codex ${detail.origin.cliVersion} · ${detail.origin.account}` : "缺少已记录来源证据",
      "会话 ID": run.threadId ?? "未记录", "准确回合 ID": run.turnId ?? "未记录", "错误": run.error ?? "无" };
    const controls: HTMLButtonElement[] = [];
    if (["running", "queued", "waiting_quota"].includes(run.status)) {
      const cancel = button(detail.cancelRequested ? "等待取消确认" : "请求取消", () => context.confirmAction("cancel", run.id, "请求取消？运行中任务需要等待准确回合终止确认，未确认会保留待核对。"), "danger-button");
      cancel.disabled = detail.cancelRequested; controls.push(cancel);
    }
    if (["queued", "waiting_quota"].includes(run.status)) controls.push(realButton(button("手动启动此快照", () => context.confirmAction("run-start", run.id, "执行此持久化快照？将使用记录中的版本、项目和权限。")), context));
    if (run.status === "needs_attention") controls.push(realButton(button("只读核对", () => context.act("inspect", { id: run.id }, "已开始只读核对，摘要见异常处理与后台操作。")), context), realButton(button("应用已确认结果", () => context.confirmAction("reconcile", run.id, "按已记录来源和准确回合读取并应用已确认终态？不会发送新任务。")), context));
    for (const control of controls) control.dataset.runAction = control.textContent ?? "";
    $("run-detail").replaceChildren(badge(run.status), ...(detail.cancelRequested && run.status === "running" ? [el("p", { class: "mode-banner" }, "取消请求已发出 · 等待准确回合终态；尚未确认取消。")] : []),
      el("dl", { class: "detail-grid" }, ...Object.entries(fields).flatMap(([key, value]) => [el("dt", {}, key), el("dd", {}, value)])),
      el("div", { class: "detail-actions" }, ...controls),
      el("div", { class: "panel-heading" }, el("h2", {}, outputLabel(run)), button("复制输出", async () => { await copyText(run.output); notice("输出已复制。"); }), button("到输出末尾", async () => { const output = $("run-output"); output.scrollTop = output.scrollHeight; })),
      el("pre", { id: "run-output", class: "run-output", tabindex: "0", "aria-label": "已保存的执行输出" }, run.output || "尚无输出"),
      el("details", {}, el("summary", {}, "查看不可变指令快照"), button("复制指令快照", async () => { await copyText(run.promptSnapshot); notice("指令快照已复制。"); }), el("pre", {}, run.promptSnapshot)),
      el("details", {}, el("summary", {}, "执行与恢复审计"), el("pre", {}, [...detail.events, ...detail.recovery].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((event) => `${time(event.createdAt)} ${event.type} ${JSON.stringify(event.data)}`).join("\n") || "尚无事件")));
    document.querySelectorAll<HTMLDetailsElement>("#run-detail details").forEach((node, index) => { node.open = expanded[index] ?? false; });
    $("run-output").scrollTop = outputTop; $("run-output").scrollLeft = outputLeft; dialog.scrollTop = scroll;
    if (focused) [...document.querySelectorAll<HTMLButtonElement>("[data-run-action]")].find((node) => node.dataset.runAction === focused)?.focus({ preventScroll: true });
  }
  document.addEventListener("selectionchange", () => { if (deferred && !selected()) draw(deferred); });
  return { draw, reset };
}
