import { $, el, empty, button, time, setDisabled, busy, notice } from "./dom.js";
import { realButton, type UiContext } from "./context.js";
import { recoveryGuidance } from "./recovery-model.js";
import { api } from "./api.js";
import type { RunPage } from "../../domain/task.js";

export function recoveryView(context: UiContext) {
  let offset = 0, sequence = 0;
  let page: RunPage | null = null;
  function render() {
  const state = context.state(); if (!state) return;
  const report = state.recovery;
  $("recovery-checked").textContent = `本地检查 ${time(report.checkedAt)}`;
  $("recovery-report").replaceChildren(...(report.issues.length ? report.issues.map((issue) => el("div", { class: "issue" },
    el("strong", {}, `${issue.code} · ${issue.runId ?? "进程状态"} · PID ${issue.ownerPid ?? "未知"}`), el("p", {}, recoveryGuidance(issue.code)), issue.runId ? button("查看原记录", () => context.openRun(issue.runId!)) : null)) : [empty("未发现需要修复的本地状态。")]),
    ...report.owners.map((owner) => el("p", { class: "hint" }, `${owner.kind} · PID ${owner.pid} · ${owner.state === "alive" ? "进程仍在运行，不能修复释放" : owner.state === "unknown" ? "无法确认退出，保持执行权" : "已确认退出，修复前仍会事务重验"}`)));
  const jobs = state.jobs.filter((job) => ["inspect", "reconcile"].includes(job.kind));
  $("recovery-results").replaceChildren(...(jobs.length ? jobs.slice(-6).reverse().map((job) => el("div", { class: "job-row" }, el("div", {},
    el("strong", {}, `${job.kind === "inspect" ? "只读核对" : "应用核对结果"} · ${job.state === "running" ? "处理中" : job.state === "failed" ? "尚未确认或操作未完成" : job.kind === "inspect" ? "已确认远端终态，尚未自动应用" : "已应用已确认结果"}`),
    el("small", {}, job.code ?? job.detail ?? "等待后台结果")), job.runId ? button("查看详情与审计", () => context.openRun(job.runId!)) : null)) : [empty("尚无本次后台会话的核对操作。持久化应用审计可在运行详情查看。") ]));
  if (!page) { $("attention").replaceChildren(empty("正在读取待核对记录…")); return; }
  $("attention-count-label").textContent = `${page.total} 条待核对状态 · 第 ${offset / 25 + 1} 页`;
  setDisabled($<HTMLButtonElement>("attention-prev"), offset === 0); setDisabled($<HTMLButtonElement>("attention-next"), offset + page.items.length >= page.total);
  $("attention").replaceChildren(...(page.items.length ? page.items.map((run) => {
    const blocked = state.scheduler.attention.includes(run.id);
    const acknowledge = button(blocked ? "确认已人工核对" : "已人工确认", () => context.confirmAction("acknowledge", run.id, "确认已人工核对原会话与文件变更？仅解除调度阻塞，状态仍保留待核对，不会重发。"));
    setDisabled(acknowledge, !blocked || !context.connected());
    return el("div", { class: "attention-card" }, el("strong", {}, run.name), el("p", { class: "subtle" }, `${run.id} · v${run.taskRevision} · ${run.projectDir}`),
      el("p", { class: "hint" }, `原会话 ${run.threadId ?? "未记录"} · 准确回合 ${run.turnId ?? "未记录"}`),
      el("p", { class: "hint" }, blocked ? "仍阻塞自动派发。先核对执行证据，再选择应用或确认。" : "已解除该记录的派发阻塞；状态仍待核对，队列不会自动恢复。"),
      el("div", { class: "actions wrap" }, button("查看记录", () => context.openRun(run.id)), realButton(button("只读核对", () => context.act("inspect", { id: run.id }, "核对已开始，只读取原来源与准确回合。")), context),
        realButton(button("应用已确认结果", () => context.confirmAction("reconcile", run.id, "按已记录来源、账户、目录和准确回合读取并应用已确认终态？不会重新发送指令。")), context), acknowledge));
  }) : [empty("暂无待核对状态的运行。") ]));
  }
  async function load() {
    const current = ++sequence;
    const result = await api<RunPage>(`/api/runs/page?status=needs_attention&offset=${offset}&limit=25`);
    if (current !== sequence) return;
    if (result.total && offset >= result.total) { offset = Math.floor((result.total - 1) / 25) * 25; await load(); return; }
    page = result; render();
  }
  $("attention-prev").onclick = () => { void busy($<HTMLButtonElement>("attention-prev"), async () => { offset = Math.max(0, offset - 25); await load(); }); };
  $("attention-next").onclick = () => { void busy($<HTMLButtonElement>("attention-next"), async () => { offset += 25; await load(); }); };
  $("recovery-refresh").onclick = () => { void busy($<HTMLButtonElement>("recovery-refresh"), async () => { await context.refresh(); await load(); notice("已重新读取本地检查和待核对状态。"); }); };
  return { render, load };
}
