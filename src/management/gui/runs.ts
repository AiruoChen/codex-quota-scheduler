import type { RunDetail } from "../contracts.js";
import type { RunPage } from "../../domain/task.js";
import { api } from "./api.js";
import { $, el, time, button, busy, setDisabled, showDialog, notice } from "./dom.js";
import { badge } from "./labels.js";
import type { UiContext } from "./context.js";
import { runDetails } from "./run-detail.js";
import { SelectedResource } from "./selected-resource.js";

export function runsView(context: UiContext) {
  let offset = 0, runsRequest = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const details = runDetails(context);
  const selected = new SelectedResource<RunDetail>((id) => api(`/api/run?id=${encodeURIComponent(id)}`), details.draw);
  async function load() {
    const request = ++runsRequest;
    const params = new URLSearchParams({ offset: String(offset), limit: "25", search: $<HTMLInputElement>("runs-search").value.trim(), status: $<HTMLSelectElement>("runs-filter").value });
    const page = await api<RunPage>(`/api/runs/page?${params}`);
    if (request !== runsRequest) return;
    if (page.total && offset >= page.total) { offset = Math.floor((page.total - 1) / 25) * 25; await load(); return; }
    const runs = page.items;
    $("runs-page").textContent = `${page.total} 条 · 第 ${offset / 25 + 1} 页`;
    setDisabled($<HTMLButtonElement>("runs-prev"), offset === 0); setDisabled($<HTMLButtonElement>("runs-next"), offset + runs.length >= page.total);
    $("runs-empty").hidden = runs.length > 0;
    $("runs-empty").textContent = "没有符合筛选条件的运行记录。可调整状态或搜索关键词。";
    $("run-rows").replaceChildren(...runs.map((run) => el("tr", {}, el("td", {}, el("strong", {}, run.name), el("small", {}, run.id), el("small", { title: run.projectDir }, run.projectDir)), el("td", {}, badge(run.status)), el("td", {}, `v${run.taskRevision}`), el("td", { class: "subtle" }, time(run.createdAt)), el("td", {}, button("查看详情", () => open(run.id))))));
  }
  const render = () => selected.load();
  async function open(id: string) {
    if (selected.id !== id) { selected.select(id); details.reset(); $("run-title").textContent = "读取运行记录"; }
    showDialog("run-dialog"); await render();
  }
  $<HTMLDialogElement>("run-dialog").addEventListener("close", () => { if (!$<HTMLDialogElement>("run-dialog").open) { selected.select(null); details.reset(); } });
  $("run-refresh").onclick = () => { void busy($<HTMLButtonElement>("run-refresh"), render); };
  $("runs-prev").onclick = () => { void busy($<HTMLButtonElement>("runs-prev"), async () => { offset = Math.max(0, offset - 25); await load(); }); };
  $("runs-next").onclick = () => { void busy($<HTMLButtonElement>("runs-next"), async () => { offset += 25; await load(); }); };
  for (const id of ["runs-search", "runs-filter"]) $(id).addEventListener(id === "runs-search" ? "input" : "change", () => {
    offset = 0; runsRequest++; clearTimeout(debounce); debounce = setTimeout(() => { void load().catch((error: unknown) => notice(String(error), true)); }, 200);
  });
  return { load, open, render, isOpen: () => $<HTMLDialogElement>("run-dialog").open };
}
