import type { RunSummary, RunDetail } from "../contracts.js";
import { api } from "./api.js";
import { $, el, time, button, busy, setDisabled, showDialog } from "./dom.js";
import { badge } from "./labels.js";
import { realButton, type UiContext } from "./context.js";

export function runsView(context: UiContext) {
  let offset = 0, runsRequest = 0, detailRequest = 0;
  let runId: string | null = null, lastDetail = "";
  async function load() {
    const request = ++runsRequest;
    const runs = await api<RunSummary[]>(`/api/runs?offset=${offset}`);
    if (request !== runsRequest) return;
    $("runs-page").textContent = `第 ${offset / 50 + 1} 页`;
    setDisabled($<HTMLButtonElement>("runs-prev"), offset === 0); setDisabled($<HTMLButtonElement>("runs-next"), runs.length < 50);
    $("runs-empty").hidden = runs.length > 0;
    $("run-rows").replaceChildren(...runs.map((run) => el("tr", {}, el("td", {}, el("strong", {}, run.name), el("small", {}, run.id)), el("td", {}, badge(run.status)), el("td", {}, `v${run.taskRevision}`), el("td", { class: "subtle" }, time(run.createdAt)), el("td", {}, button("查看详情", () => open(run.id))))));
  }
  async function render() {
    if (!runId) return;
    const request = ++detailRequest;
    const detail = await api<RunDetail>(`/api/run?id=${encodeURIComponent(runId)}`);
    if (request !== detailRequest) return;
    const serialized = JSON.stringify(detail);
    if (lastDetail === serialized) return;
    lastDetail = serialized;
    const dialog = $<HTMLDialogElement>("run-dialog"), scroll = dialog.scrollTop;
    const expanded = Array.from(document.querySelectorAll<HTMLDetailsElement>("#run-detail details")).map((node) => node.open);
    const run = detail.run;
    $("run-title").textContent = run.taskSnapshot.name;
    const fields = { "运行 ID": run.id, "任务版本": `v${run.taskRevision}`, "创建时间": time(run.createdAt), "完成时间": time(run.completedAt), "会话 ID": run.threadId ?? "未记录", "回合 ID": run.turnId ?? "未记录", "错误": run.error ?? "无" };
    const controls: HTMLButtonElement[] = [];
    if (["running", "queued", "waiting_quota"].includes(run.status)) controls.push(button("请求取消", () => context.confirmAction("cancel", run.id, "请求取消？运行中任务需要等待准确回合终止确认。"), "danger-button"));
    if (["queued", "waiting_quota"].includes(run.status)) controls.push(realButton(button("手动启动此快照", () => context.confirmAction("run-start", run.id, "执行此持久化快照？将使用记录中的版本与指令。")), context));
    if (run.status === "needs_attention") controls.push(realButton(button("只读核对", () => context.act("inspect", { id: run.id }, "已开始只读核对。")), context), realButton(button("应用已确认结果", () => context.confirmAction("reconcile", run.id, "读取准确回合并应用已确认结果？不会重新发送任务。")), context));
    $("run-detail").replaceChildren(badge(run.status), el("dl", { class: "detail-grid" }, ...Object.entries(fields).flatMap(([key, value]) => [el("dt", {}, key), el("dd", {}, value)])), el("div", { class: "detail-actions" }, ...controls), el("h2", {}, "执行输出"), el("pre", {}, run.output || "尚无输出"), el("details", {}, el("summary", {}, "查看不可变指令快照"), el("pre", {}, run.promptSnapshot)), el("details", {}, el("summary", {}, "执行与恢复事件"), el("pre", {}, [...detail.events, ...detail.recovery].map((event) => `${event.createdAt} ${event.type} ${JSON.stringify(event.data)}`).join("\n") || "尚无事件")));
    document.querySelectorAll<HTMLDetailsElement>("#run-detail details").forEach((node, index) => { node.open = expanded[index] ?? false; });
    dialog.scrollTop = scroll;
  }
  async function open(id: string) {
    runId = id; await render(); if (runId === id) showDialog("run-dialog");
  }
  $<HTMLDialogElement>("run-dialog").addEventListener("close", () => { runId = null; detailRequest++; lastDetail = ""; });
  $("runs-prev").onclick = () => { void busy($<HTMLButtonElement>("runs-prev"), async () => { offset = Math.max(0, offset - 50); await load(); }); };
  $("runs-next").onclick = () => { void busy($<HTMLButtonElement>("runs-next"), async () => { offset += 50; await load(); }); };
  return { load, open, render, isOpen: () => $<HTMLDialogElement>("run-dialog").open };
}
