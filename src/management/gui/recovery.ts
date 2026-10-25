import { $, el, empty, button, short } from "./dom.js";
import { realButton, type UiContext } from "./context.js";

export function renderRecovery(context: UiContext) {
  const state = context.state(); if (!state) return;
  const report = state.recovery;
  $("recovery-report").replaceChildren(...(report.issues.length ? report.issues.map((issue) => el("div", { class: "issue" }, `${issue.code} · ${issue.runId ?? "进程状态"} · PID ${issue.ownerPid ?? "未知"}`)) : [empty("未发现需要修复的本地状态。")]), ...report.owners.map((owner) => el("p", { class: "hint" }, `${owner.kind} · PID ${owner.pid} · ${owner.state}`)));
  $("attention").replaceChildren(...(state.scheduler.attention.length ? state.scheduler.attention.map((id) => el("div", { class: "attention-row" }, el("div", {}, el("strong", {}, short(id)), el("small", {}, "请核对原会话和文件变更")), el("div", { class: "actions" }, button("查看", () => context.openRun(id)), realButton(button("只读核对", () => context.act("inspect", { id }, "已开始只读核对。")), context), realButton(button("应用已确认结果", () => context.confirmAction("reconcile", id, "读取准确回合并应用已确认结果？不会重发任务。")), context), button("确认已核对", () => context.confirmAction("acknowledge", id, "确认已人工核对会话与文件变更？此操作只解除阻塞，保留待处理状态。"))))) : [empty("暂无未确认的运行记录。") ]));
}
