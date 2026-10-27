import type { StoredTask, TaskPage } from "../../domain/task.js";
import { api, viewScope } from "./api.js";
import { $, el, button, busy, notice, showDialog, setDisabled, time } from "./dom.js";
import { realButton, type UiContext } from "./context.js";
import { taskPreview } from "./task-preview.js";
import { canChooseDirectory, chooseDirectory } from "./native.js";
import { taskCatalog } from "./task-catalog.js";

export function tasksView(context: UiContext) {
  let editing: StoredTask | null = null;
  let request = 0, opening = 0, offset = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const preview = taskPreview(context);
  const form = $<HTMLFormElement>("task-form"), catalog = taskCatalog(form);
  let createRequest = crypto.randomUUID();
  const sort = $<HTMLSelectElement>("task-sort"); let sortLoaded = false;
  async function open(id?: string) {
    const sequence = ++opening;
    const task = id ? await api<StoredTask>(`/api/task?id=${encodeURIComponent(id)}`) : null;
    if (sequence !== opening) return;
    editing = task;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    form.reset(); $("task-error").textContent = "";
    $("editor-title").textContent = editing ? `编辑任务 · v${editing.revision}` : "新建任务";
    if (!task) createRequest = crypto.randomUUID();
    for (const name of ["id", "name", "projectDir", "priority"] as const) field(name).value = String(editing?.[name] ?? (name === "priority" ? 10 : ""));
    field("id").disabled = false; field("enabled").checked = editing?.enabled ?? true;
    field("prompt").value = editing?.promptSnapshot ?? ""; field("sandbox").value = editing?.execution?.sandbox ?? "read-only";
    field("timeout").value = String((editing?.execution?.timeoutMs ?? 900000) / 1000);
    field("effort").value = editing?.execution?.effort ?? ""; field("session").value = editing?.session.mode ?? "new";
    field("continuation").checked = editing?.quotaContinuation?.enabled ?? false;
    field("maxAttempts").value = String(editing?.quotaContinuation?.maxAttempts ?? 3);
    $("reload-task").hidden = !task; explain(); showDialog("task-dialog");
    void catalog.open(task).catch(error => { if (sequence === opening) $("catalog-status").textContent = error instanceof Error ? error.message : "读取目录失败，可重试。"; });
  }
  async function load() {
    if (!sortLoaded) {
      try { const saved = localStorage.getItem(`cqs-task-sort:${viewScope()}`); if (saved === "created_asc" || saved === "created_desc") sort.value = saved; } catch { /* Sorting remains usable without browser storage. */ }
      sortLoaded = true;
    }
    const current = ++request;
    const params = new URLSearchParams({ offset: String(offset), limit: "25", search: $<HTMLInputElement>("task-search").value.trim(), enabled: $<HTMLSelectElement>("task-filter").value, sort: sort.value });
    const page = await api<TaskPage>(`/api/tasks/page?${params}`);
    if (current !== request) return;
    if (page.total && offset >= page.total) { offset = Math.floor((page.total - 1) / 25) * 25; await load(); return; }
    const tasks = page.items;
    $("task-count").textContent = `${page.total} 个任务 · 第 ${Math.floor(offset / 25) + 1} 页`;
    setDisabled($<HTMLButtonElement>("tasks-prev"), offset === 0); setDisabled($<HTMLButtonElement>("tasks-next"), offset + tasks.length >= page.total);
    $("tasks-empty").hidden = tasks.length > 0;
    $("task-rows").replaceChildren(...tasks.map((task) => el("tr", {}, el("td", {}, el("strong", {}, task.name), el("small", { title: task.projectDir }, `${task.id} · ${task.projectDir}`)), el("td", {}, time(task.createdAt)), el("td", {}, `v${task.revision}`), el("td", {}, task.priority), el("td", {}, el("span", { class: `badge ${task.enabled ? "good" : ""}` }, task.enabled ? "启用" : "停用")),
      el("td", {}, el("div", { class: "actions wrap" }, button("编辑", () => open(task.id)), button("加入队列", () => preview.open(task.id, "enqueue")), realButton(button("执行", () => preview.open(task.id, "run")), context),
        button(task.enabled ? "停用" : "启用", () => context.act("task-enable", { id: task.id, revision: task.revision, enabled: !task.enabled }, "启用状态已保存为新版本，旧快照不变。")),
        button("归档", async () => { if (confirm(`归档“${task.name}”？历史保留，未领取快照将被跳过；当前运行继续。`)) await context.act("task-delete", { id: task.id, revision: task.revision }, "任务已归档。"); }, "quiet"))))));
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void busy(form.querySelector<HTMLButtonElement>("button[type=submit]")!, async () => {
      const current = opening;
      const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
      try {
        const definition = { ...(editing ? { id: editing.id } : {}), name: field("name").value, projectDir: field("projectDir").value,
          priority: Number(field("priority").value), enabled: field("enabled").checked,
          session: field("session").value === "new" ? { mode: "new" } : { mode: "resume", threadId: field("threadId").value },
          execution: { sandbox: field("sandbox").value, timeoutMs: Number(field("timeout").value) * 1000, ...(field("effort").value ? { effort: field("effort").value } : {}) },
          quotaContinuation: { enabled: field("continuation").checked, maxAttempts: Number(field("maxAttempts").value) },
          ...(field("model").value.trim() ? { model: field("model").value.trim() } : {}), ...(editing ? { promptFile: editing.promptFile } : {}) };
        await api("/api/action", { action: "task-save", definition, prompt: field("prompt").value, ...catalog.target(), ...(editing ? { revision: editing.revision } : { requestId: createRequest }) });
        offset = 0;
        if (current === opening) $<HTMLDialogElement>("task-dialog").close(); notice("任务已保存，已返回第一页。当前筛选可能隐藏新任务；旧运行快照保持不变。"); await load();
      } catch (error) { if (current === opening) $("task-error").textContent = `${error instanceof Error ? error.message : "保存失败"}。草稿已保留；请核对后重试，或选择“重新加载服务器版本”。`; }
    });
  });
  function explain() {
    const fields = form.elements;
    const value = (name: string) => (fields.namedItem(name) as HTMLInputElement).value;
    $("prompt-count").textContent = `${value("prompt").length.toLocaleString("zh-CN")} 字符`;
    $("continuation-preview").textContent = (fields.namedItem("continuation") as HTMLInputElement).checked ? `${value("prompt")}\n\n请继续这个被截断的任务` : "自动续接默认关闭。仅对确认因真实额度耗尽而失败的回合生效。";
    $("continuation-preview").hidden = !(fields.namedItem("continuation") as HTMLInputElement).checked;
    $("sandbox-help").textContent = value("sandbox") === "workspace-write" ? `允许修改项目目录：${value("projectDir") || "请先填写目录"}` : "只读权限，不允许修改项目文件。";
  }
  form.addEventListener("input", explain);
  $<HTMLDialogElement>("task-dialog").addEventListener("close", () => { opening++; catalog.close(); void load().catch((error: unknown) => notice(String(error), true)); });
  $("reload-task").onclick = () => { void busy($<HTMLButtonElement>("reload-task"), async () => { if (editing && confirm("放弃当前未保存草稿，加载服务器最新版本？")) await open(editing.id); }); };
  const picker = $<HTMLButtonElement>("choose-project");
  picker.disabled = !canChooseDirectory(); picker.title = picker.disabled ? "网页模式请手动填写项目路径" : "打开系统目录选择器";
  picker.onclick = () => { void busy(picker, async () => { const path = await chooseDirectory(); if (path !== null && $<HTMLDialogElement>("task-dialog").open) { (form.elements.namedItem("projectDir") as HTMLInputElement).value = path; explain(); } }); };
  for (const id of ["task-search", "task-filter"]) $(id).addEventListener(id === "task-search" ? "input" : "change", () => {
    offset = 0; request++; clearTimeout(debounce); debounce = setTimeout(() => { void load().catch((error: unknown) => notice(String(error), true)); }, 200);
  });
  sort.onchange = () => { offset = 0; try { localStorage.setItem(`cqs-task-sort:${viewScope()}`, sort.value); } catch { /* Storage is optional. */ } void load().catch(error => notice(String(error), true)); };
  $("tasks-prev").onclick = () => { void busy($<HTMLButtonElement>("tasks-prev"), async () => { offset = Math.max(0, offset - 25); await load(); }); };
  $("tasks-next").onclick = () => { void busy($<HTMLButtonElement>("tasks-next"), async () => { offset += 25; await load(); }); };
  $("new-task").onclick = () => { void busy($<HTMLButtonElement>("new-task"), () => open()); };
  return { load, editing: () => $<HTMLDialogElement>("task-dialog").open };
}
