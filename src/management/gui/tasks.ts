import type { StoredTask } from "../../domain/task.js";
import { api } from "./api.js";
import { $, el, button, busy, notice, showDialog } from "./dom.js";
import { realButton, type UiContext } from "./context.js";

export function tasksView(context: UiContext) {
  let editing: StoredTask | null = null;
  let request = 0;
  async function open(id?: string) {
    editing = id ? await api<StoredTask>(`/api/task?id=${encodeURIComponent(id)}`) : null;
    const form = $<HTMLFormElement>("task-form");
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    form.reset(); $("task-error").textContent = "";
    $("editor-title").textContent = editing ? `编辑任务 · v${editing.revision}` : "新建任务";
    for (const name of ["id", "name", "projectDir", "priority", "model"] as const) field(name).value = String(editing?.[name] ?? (name === "priority" ? 10 : ""));
    field("id").disabled = !!editing; field("enabled").checked = editing?.enabled ?? true;
    field("prompt").value = editing?.promptSnapshot ?? ""; field("sandbox").value = editing?.execution?.sandbox ?? "read-only";
    field("timeout").value = String((editing?.execution?.timeoutMs ?? 900000) / 1000);
    field("effort").value = editing?.execution?.effort ?? ""; field("session").value = editing?.session.mode ?? "new";
    field("threadId").value = editing?.session.mode === "resume" ? editing.session.threadId : "";
    showDialog("task-dialog");
  }
  async function load() {
    const current = ++request;
    const tasks = await api<Omit<StoredTask, "promptSnapshot">[]>("/api/tasks");
    if (current !== request) return;
    $("tasks-empty").hidden = tasks.length > 0;
    $("task-rows").replaceChildren(...tasks.map((task) => el("tr", {}, el("td", {}, el("strong", {}, task.name), el("small", { title: task.projectDir }, `${task.id} · ${task.projectDir}`)), el("td", {}, `v${task.revision}`), el("td", {}, task.priority), el("td", {}, el("span", { class: `badge ${task.enabled ? "good" : ""}` }, task.enabled ? "启用" : "停用")),
      el("td", {}, el("div", { class: "actions" }, button("编辑", () => open(task.id)), button("加入队列", () => context.act("enqueue", { id: task.id }, "已保存此版本的队列快照，暂停时不派发。")), realButton(button("执行", () => context.confirmAction("run", task.id, `现在手动执行“${task.name}”？将检查真实账户与额度。`)), context), button("归档", async () => { if (confirm(`归档“${task.name}”？历史记录会保留。`)) await context.act("task-delete", { id: task.id, revision: task.revision }, "任务已归档。"); }, "quiet"))))));
  }
  const form = $<HTMLFormElement>("task-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void busy(form.querySelector<HTMLButtonElement>("button[type=submit]")!, async () => {
      const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
      try {
        const definition = { id: field("id").value, name: field("name").value, projectDir: field("projectDir").value,
          priority: Number(field("priority").value), enabled: field("enabled").checked,
          session: field("session").value === "new" ? { mode: "new" } : { mode: "resume", threadId: field("threadId").value },
          execution: { sandbox: field("sandbox").value, timeoutMs: Number(field("timeout").value) * 1000, ...(field("effort").value ? { effort: field("effort").value } : {}) },
          ...(field("model").value.trim() ? { model: field("model").value.trim() } : {}), ...(editing ? { promptFile: editing.promptFile } : {}) };
        await api("/api/action", { action: "task-save", definition, prompt: field("prompt").value, ...(editing ? { revision: editing.revision } : {}) });
        $<HTMLDialogElement>("task-dialog").close(); notice("任务已保存。旧运行快照保持不变。"); await load();
      } catch (error) { $("task-error").textContent = error instanceof Error ? error.message : "保存失败；草稿已保留"; }
    });
  });
  $("new-task").onclick = () => { void busy($<HTMLButtonElement>("new-task"), () => open()); };
  return { load, editing: () => $<HTMLDialogElement>("task-dialog").open };
}
