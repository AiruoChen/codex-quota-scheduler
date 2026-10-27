import type { StoredTask, TaskRun } from "../../domain/task.js";
import { api } from "./api.js";
import { $, el, time, busy, showDialog } from "./dom.js";
import type { UiContext } from "./context.js";

export function taskPreview(context: UiContext) {
  let preview: StoredTask | null = null;
  let mode: "enqueue" | "run" = "enqueue";
  let sequence = 0;
  const dialog = $<HTMLDialogElement>("snapshot-dialog");
  const confirm = $<HTMLButtonElement>("snapshot-confirm");
  async function open(id: string, action: "enqueue" | "run") {
    const current = ++sequence;
    const task = await api<StoredTask>(`/api/task?id=${encodeURIComponent(id)}`);
    if (current !== sequence) return;
    preview = task; mode = action;
    $("snapshot-title").textContent = `${action === "enqueue" ? "加入队列" : "手动执行"} · ${task.name} · v${task.revision}`;
    $("snapshot-body").replaceChildren(el("dl", { class: "detail-grid" },
      el("dt", {}, "项目目录"), el("dd", {}, task.projectDir), el("dt", {}, "官方项目"), el("dd", {}, task.environment?.projectKnown ? task.environment.projectId ?? "已确认无项目" : "未指定官方项目"),
      el("dt", {}, "关联文件夹"), el("dd", {}, task.environment?.roots.join("；") || "无 / 本地模式"), el("dt", {}, "文件权限"), el("dd", {}, task.execution?.sandbox === "workspace-write" ? `允许修改：${task.environment?.writableRoots.join("；") ?? task.projectDir}` : "只读，禁用网络"),
      el("dt", {}, "优先级"), el("dd", {}, task.priority), el("dt", {}, "模型 / 推理"), el("dd", {}, `${task.model ?? "Codex 默认"} / ${task.execution?.effort ?? "默认"}`),
      el("dt", {}, "会话"), el("dd", {}, task.session.mode === "new" ? "新建会话" : `续接 ${task.session.threadId}`), el("dt", {}, "保存时间"), el("dd", {}, time(task.updatedAt))),
      el("p", { class: "hint" }, task.quotaContinuation?.enabled ? `已开启额度中断续接，最多 ${task.quotaContinuation.maxAttempts} 次；原始指令后追加“请继续这个被截断的任务”。` : "额度中断自动续接未开启。"),
      ...(task.environment?.resumeAuthorization ? [el("p", { class: "hint" }, "本版本已明确授权续接：允许读取本机当前账户可读文件，写入仅限上列已确认目录，网络关闭；额外审批不会自动同意。执行前重新核验授权。原会话权限未宣称完整继承。")] : []),
      el("h2", {}, "将保存的指令快照"), el("pre", {}, task.promptSnapshot), el("p", { class: "hint" }, "确认时校验此版本。同一版本重复入队会返回既有记录，不会重复提交。"));
    $("snapshot-error").textContent = "";
    confirm.textContent = action === "enqueue" ? "确认加入队列" : "确认手动执行";
    confirm.disabled = !task.enabled || action === "run" && context.state()?.provider !== "codex";
    if (!task.enabled) $("snapshot-error").textContent = "任务已停用，请先启用并重新预览。";
    showDialog("snapshot-dialog");
  }
  confirm.onclick = () => { void busy(confirm, async () => {
    if (!preview) return;
    const selected = preview, action = mode, current = sequence;
    try {
      const result = await context.act(action, { id: selected.id, revision: selected.revision }, action === "enqueue" ? "此版本的快照已入队；派发状态保持不变。" : "已受理手动执行，请查看最终状态。") as TaskRun & { runId?: string };
      if (current !== sequence) return;
      dialog.close();
      if (action === "run" && result.runId) await context.openRun(result.runId);
    } catch (error) { if (current === sequence) $("snapshot-error").textContent = `${error instanceof Error ? error.message : "操作失败"}。请关闭并重新预览；不会自动重试。`; }
  }); };
  dialog.addEventListener("close", () => { sequence++; preview = null; void context.refresh().catch(() => {}); });
  return { open };
}
