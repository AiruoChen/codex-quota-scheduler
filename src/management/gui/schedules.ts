import type { TimedPage } from "../contracts.js";
import type { StoredTask } from "../../domain/task.js";
import type { TimedPlanInput, PlannedSlot } from "../../domain/timed-plan.js";
import { api } from "./api.js";
import { $, el, button, empty, time, notice, busy, setDisabled } from "./dom.js";
import type { UiContext } from "./context.js";
import { copyText } from "./clipboard.js";

type Plan = TimedPage["plans"][number];
interface Preview { slots: PlannedSlot[]; actualResetAt: string | null; experimental: boolean; quotaKnown: boolean;
  task: Plan["task"]; context?: string | null; conflicts?: string[]; canEnable?: boolean }
const states: Record<string, string> = { draft: "草稿", enabled: "已启用", paused: "已暂停", cancelled: "已取消", pending: "待触发", dispatching: "已领取", finished: "已结束", missed: "已错过" };
const reasons: Record<string, string> = { waiting_dispatch: "到时待派发", waiting_quota: "等待额度", quota_unknown: "额度未知", protected_period: "受其他计划保护", window_conflict: "服务端边界与目标冲突", deadline_expired: "启动有效期已过", missed_offline: "后台离线期间错过", task_disabled: "任务停用或归档", clock_changed: "系统时钟跳变，需校时后重新确认", source_changed: "来源已变化", account_changed: "账户已变化", window_changed: "服务端窗口长度已变化", plan_changed: "计划已修改", plan_stopped: "计划已停止", user_paused: "用户停止未来安排" };
const reason = (value: string | null) => value ? reasons[value] ?? value : "—";

function timeline(preview: Preview): HTMLElement {
  return el("div", {}, el("p", { class: "hint" }, preview.experimental ? "实验估算：一次真实执行可能消耗额度，不能保证首次请求启动窗口或改变重置时间。" : "指定时间为最早允许启动时刻；预检、排队和网络会产生延迟。"),
    el("p", {}, `最新服务端重置时间：${time(preview.actualResetAt)}${preview.quotaKnown ? "" : " · 额度未知，不能启用"}`),
    ...preview.slots.slice(0, 3).map(s => el("dl", { class: "detail-grid" },
      el("dt", {}, "目标日期"), el("dd", {}, `${s.date} · UTC${s.offsetMinutes >= 0 ? "+" : ""}${s.offsetMinutes / 60}${s.ambiguous ? " · 夏令时重复时间取首次" : ""}`),
      el("dt", {}, "预计执行"), el("dd", {}, `${time(s.dueAt)}（${s.dueAt}）`), el("dt", {}, "最晚启动"), el("dd", {}, time(s.deadlineAt)),
      ...(preview.experimental ? [el("dt", {}, "开始使用"), el("dd", {}, time(s.startAt)), el("dt", {}, "目标重置"), el("dd", {}, time(s.targetResetAt)), el("dt", {}, "保护截止"), el("dd", {}, time(s.protectionEndAt))] : []))),
    el("p", { class: "hint" }, `任务 v${preview.task.revision} · ${preview.task.session.mode === "new" ? "新会话" : "续接已确认会话"} · 模型 ${preview.task.model ?? "默认"} · ${preview.task.sandbox}。保持原有审批、超时和权限检查。显示时间使用本机时区，UTC 时间可用于核对。`));
}

/** Polling only replaces the list. An open editor and its unsaved fields are never overwritten. */
export function schedulesView(context: UiContext) {
  let page: TimedPage | null = null, request = 0, editing: Plan | null = null, opening = 0;
  const dialog = el("dialog", { id: "schedule-dialog", "aria-labelledby": "schedule-title" });
  const form = el("form", {}), fields = el("div", { class: "form-grid" });
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
  const text = (name: string, label: string, type = "text", value = "", extra: Record<string, string | number> = {}) =>
    el("label", {}, label, el("input", { name, type, value, required: true, ...extra }));
  const select = (name: string, label: string, options: [string, string][]) => el("label", {}, label,
    el("select", { name }, ...options.map(([value, label]) => el("option", { value }, label))));
  fields.append(text("name", "计划名称", "text", "", { maxlength: 150 }), select("taskId", "已有任务", []), select("taskRevision", "绑定任务版本（更新须重新确认）", []),
    select("mode", "计划模式", [["at_time", "指定时间执行"], ["window", "窗口衔接助手（实验估算）"]]),
    select("repeat", "重复", [["once", "单次"], ["daily", "每日"]]), text("date", "日期 / 每日开始日期", "date"),
    text("time", "执行时间 / 衔接模式的开始使用时间", "time", "08:00"), text("zone", "计划时区（IANA）", "text", Intl.DateTimeFormat().resolvedOptions().timeZone),
    text("endDate", "每日结束日期（可留空）", "date"), text("graceMinutes", "启动有效期（分钟，1–1440）", "number", "5", { min: 1, max: 1440 }),
    el("label", { class: "check-label" }, el("input", { type: "checkbox", name: "catchUp" }), "明确允许离线后在有效期内补执行一次"));
  const windowFields = el("fieldset", { class: "full" }, el("legend", {}, "窗口衔接设置"), select("slot", "服务端窗口", []),
    text("useMinutes", "开始使用多久后重置（分钟，必须小于窗口长度）", "number", "120", { min: 1 }),
    text("minPercent", "开始使用时希望剩余至少（%）", "number", "90", { min: 0, max: 100 }),
    text("protectMinutes", "开始使用后继续保护多久（分钟，至少覆盖首段）", "number", "240", { min: 1, max: 10080 }),
    el("p", { class: "hint" }, "保护从预计执行时刻开始，只限制本工具其他自动派发。不会终止活动任务，无法阻止其他客户端消耗额度。"));
  fields.append(windowFields);
  const preview = el("div", { id: "schedule-preview", "aria-live": "polite" }), error = el("p", { class: "form-error", role: "alert" });
  const save = el("button", { type: "submit", class: "primary" }, "保存草稿");
  const close = button("关闭", async () => { dialog.close(); });
  const title = el("h2", { id: "schedule-title" }, "新建定时计划");
  form.append(el("div", { class: "dialog-heading" }, title, close), fields, preview, error,
    el("div", { class: "dialog-footer" }, button("预览时间线", async () => {
      if (form.reportValidity()) preview.replaceChildren(timeline(await api<Preview>("/api/action", { action: "timed-preview", definition: definition() })));
    }), save)); dialog.append(form); document.body.append(dialog);
  field("endDate").required = false;
  let taskRevisions = new Map<string, number>();
  function explain() {
    windowFields.hidden = field("mode").value !== "window";
    windowFields.disabled = windowFields.hidden;
    field("endDate").disabled = field("repeat").value !== "daily";
  }
  function versions() {
    const id = field("taskId").value, latest = taskRevisions.get(id);
    const choices = new Set([latest, ...(editing?.input.taskId === id ? [editing.input.taskRevision] : [])].filter((v): v is number => v !== undefined));
    field("taskRevision").replaceChildren(...[...choices].map(revision => el("option", { value: revision }, `v${revision}${revision === latest ? " · 当前版本" : " · 原绑定版本"}`)));
  }
  form.addEventListener("change", event => { if (event.target === field("taskId")) versions(); explain(); preview.replaceChildren(); });
  form.addEventListener("input", () => { preview.replaceChildren(); });
  function definition(): TimedPlanInput {
    const slot = field("slot").value.split(":"), mode = field("mode").value as TimedPlanInput["mode"];
    return { name: field("name").value, taskId: field("taskId").value, taskRevision: Number(field("taskRevision").value),
      mode, zone: field("zone").value, date: field("date").value, time: field("time").value,
      repeat: field("repeat").value as TimedPlanInput["repeat"], endDate: field("repeat").value === "daily" ? field("endDate").value || null : null,
      graceMinutes: Number(field("graceMinutes").value), catchUp: (field("catchUp") as HTMLInputElement).checked,
      window: mode === "window" ? { slot: slot[0] as "primary" | "secondary", durationMinutes: Number(slot[1]), useMinutes: Number(field("useMinutes").value),
        minPercent: Number(field("minPercent").value), protectMinutes: Number(field("protectMinutes").value) } : null };
  }
  async function open(plan: Plan | null = null) {
    const seq = ++opening;
    const [tasks, latest] = await Promise.all([api<Omit<StoredTask, "promptSnapshot">[]>("/api/tasks"), api<TimedPage>("/api/timed-plans")]);
    if (seq !== opening) return;
    page = latest; editing = plan; form.reset(); preview.replaceChildren(); error.textContent = "";
    taskRevisions = new Map(tasks.filter(t => t.enabled).map(t => [t.id, t.revision]));
    field("taskId").replaceChildren(...tasks.filter(t => t.enabled).map(t => el("option", { value: t.id }, `${t.name} · v${t.revision}`)));
    if (plan) {
      const option = Array.from((field("taskId") as HTMLSelectElement).options).find(o => o.value === plan.input.taskId);
      if (!option) field("taskId").append(el("option", { value: plan.input.taskId }, `${plan.task.name}（原绑定任务，可能已停用）`));
    }
    field("slot").replaceChildren(...latest.windows.filter(w => w.durationMinutes !== null && w.durationMinutes > 1).map(w => el("option", { value: `${w.slot}:${w.durationMinutes}` }, `${w.slot === "primary" ? "主" : "次"}窗口 · ${w.durationMinutes} 分钟`)));
    if (plan?.input.window && !Array.from((field("slot") as HTMLSelectElement).options).some(o => o.value === `${plan.input.window!.slot}:${plan.input.window!.durationMinutes}`)) field("slot").append(el("option", { value: `${plan.input.window.slot}:${plan.input.window.durationMinutes}` }, "原窗口（请核对最新服务端数据）"));
    const tomorrow = new Date(Date.now() + 86400000);
    field("date").value = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    if (plan) {
      for (const key of ["name", "taskId", "mode", "repeat", "date", "time", "zone", "graceMinutes"] as const) field(key).value = String(plan.input[key]);
      field("endDate").value = plan.input.endDate ?? ""; (field("catchUp") as HTMLInputElement).checked = plan.input.catchUp;
      if (plan.input.window) { field("slot").value = `${plan.input.window.slot}:${plan.input.window.durationMinutes}`;
        for (const key of ["useMinutes", "minPercent", "protectMinutes"] as const) field(key).value = String(plan.input.window[key]); }
    }
    versions(); if (plan) field("taskRevision").value = String(plan.input.taskRevision);
    title.textContent = plan ? `编辑计划 · v${plan.revision}（保存后需重新启用）` : "新建定时计划";
    explain(); dialog.showModal();
  }
  form.addEventListener("submit", event => {
    event.preventDefault(); void busy(save, async () => {
      const seq = opening;
      try {
        const input = definition();
        if (editing && !confirm("保存会停止此计划未来安排并撤销其保护，改为草稿；已开始的运行继续。确认保存？")) return;
        await api("/api/action", { action: "timed-save", definition: input, ...(editing ? { id: editing.id, revision: editing.revision } : {}) });
        if (seq === opening) dialog.close(); notice("草稿已保存，尚未授权执行。请在列表中预览并启用。"); await load();
      } catch (e) { if (seq === opening) error.textContent = `${e instanceof Error ? e.message : "保存失败"}。草稿已保留；可关闭后重新编辑服务器版本。`; }
    });
  });
  dialog.addEventListener("close", () => { opening++; });
  async function enable(p: Plan) {
    const data = await api<Preview>("/api/action", { action: "timed-confirmation", id: p.id, revision: p.revision });
    const consent = el("input", { type: "checkbox" }), estimate = el("input", { type: "checkbox" }), protection = el("input", { type: "checkbox" });
    const modal = el("dialog", { "aria-label": "确认启用计划" }), feedback = el("p", { class: "form-error", role: "alert" });
    const confirmButton = button("确认启用计划", async () => {
      if (!consent.checked || p.input.mode === "window" && (!estimate.checked || !protection.checked)) { feedback.textContent = "请逐项明确确认本次授权。"; return; }
      try {
        await context.act("timed-enable", { id: p.id, revision: p.revision, context: data.context, confirm: true, estimate: estimate.checked, protection: protection.checked }, "计划已启用。若调度未运行或派发暂停，当前仍不会执行。");
        modal.close(); await load();
      } catch (e) { feedback.textContent = `${e instanceof Error ? e.message : "启用失败"}。请关闭后重新预览确认。`; }
    }, "primary");
    setDisabled(confirmButton, !data.canEnable || !!data.conflicts?.length);
    modal.append(el("h2", {}, `启用 ${p.input.name} · ${p.input.repeat === "daily" ? "每日" : "单次"}`), timeline(data),
      el("p", { class: "hint" }, `离线有效期内补执行：${p.input.catchUp ? "已选择允许" : "不允许，默认跳过"}。保护与活动任务冲突：${context.state()?.currentRun ? "当前已有运行，无法保证准时" : "当前无活动运行"}。`),
      el("label", { class: "check-label" }, consent, "我已核对任务版本、重复规则、会话和权限，授权无人值守执行"),
      ...(p.input.mode === "window" ? [el("label", { class: "check-label" }, estimate, "我理解实验估算可能失败，预触发会消耗额度"), el("label", { class: "check-label" }, protection, "我确认上述保护时段，仅允许本预触发实例；其他自动任务等待")] : []),
      ...(!data.canEnable ? [el("p", { class: "notice" }, "当前不能启用：需要真实来源、文件数据库及新鲜完整额度。请先查询额度。")] : []),
      ...(data.conflicts?.length ? [el("p", { class: "notice" }, "与其他计划保护时段冲突，请调整后再启用。")] : []),
      feedback, el("div", { class: "dialog-footer" }, button("关闭", async () => { modal.close(); }), confirmButton));
    modal.addEventListener("close", () => modal.remove()); document.body.append(modal); modal.showModal();
  }
  function render() {
    const state = context.state();
    $("schedule-status").textContent = !context.connected() ? "服务离线，当前不会执行；显示上次状态。" : state?.loop !== "scheduler" || state.scheduler.paused ? "计划可保存和启用，但当前不会执行：请在调度队列启动调度进程并明确恢复派发。" : "调度运行中：到时仍须通过额度、账户、权限和执行权校验。";
    $("schedule-protection").textContent = page?.protections.length ? page.protections.map(h => `正在保护：${h.name}，截止 ${time(h.endAt)}`).join("；") : "当前无生效的计划保护时段。";
    if (!page) return;
    $("schedule-items").replaceChildren(...(page.plans.length ? page.plans.map(p => el("article", { class: "panel", "data-plan-id": p.id },
      el("div", { class: "panel-heading" }, el("h2", {}, p.input.name), el("span", { class: "badge" }, states[p.state] ?? p.state)),
      el("p", {}, `${p.task.name} · 任务 v${p.task.revision} · ${p.input.mode === "window" ? "窗口衔接（实验）" : "指定时间"} · ${p.input.repeat === "daily" ? "每日" : "单次"} · ${p.input.zone}`),
      el("p", {}, `下次计划：${time(p.next?.dueAt)}（以启用和派发状态为准） · ${reason(p.reason)}`),
      el("div", { class: "actions wrap" }, button("编辑", () => open(p)),
        ...(p.state !== "enabled" ? [button("预览并启用", () => enable(p))] : [button("暂停计划", async () => { if (confirm("暂停未来安排并撤销此计划自己的保护？活动运行继续；派发开关保持不变。")) { await context.act("timed-pause", { id: p.id, revision: p.revision, confirm: true }); await load(); } })]),
        ...(p.state !== "cancelled" ? [button("取消未来安排", async () => { if (confirm("取消未来及未领取实例并撤销其保护？历史保留，活动运行继续。")) { await context.act("timed-cancel", { id: p.id, revision: p.revision, confirm: true }); await load(); } }, "quiet")] : []),
        button("复制安全诊断", async () => { const data = await api<unknown>(`/api/timed-plan/diagnostics?id=${encodeURIComponent(p.id)}`); await copyText(JSON.stringify(data, null, 2)); notice("定时计划脱敏诊断已复制。"); })),
      el("details", {}, el("summary", {}, "最近实例与实际观测"), ...(p.occurrences.length ? p.occurrences.slice(0, 12).map(o => el("div", { class: "queue-item" }, el("div", {},
        el("strong", {}, `${o.date} · ${states[o.state]} · ${reason(o.reason)}`), el("small", {}, `预计 ${time(o.dueAt)}；最晚启动 ${time(o.deadlineAt)}`),
        el("small", {}, `实际开始预检 ${time(o.actualStartedAt)}；发送边界记录 ${time(o.submittedAt)}（不等于服务端确认成功）`),
        ...(o.observation ? [el("small", {}, `历史观测：服务端实际重置 ${time(o.observation.actualResetAt)}；剩余 ${o.observation.remainingPercent ?? "未知"}% · ${time(o.observation.fetchedAt)}（不代表当前可用）`), el("small", {}, `与目标${o.observation.alignment === "matching" ? "相符" : o.observation.alignment === "different" ? "不符" : "关系未知"}；开始使用时目标${o.observation.ready === "met" ? "已达成" : o.observation.ready === "not_met" ? "未达成" : "未知"}；确认刷新 ${time(o.observation.resetConfirmedAt)}`)] : [])),
        ...(o.runId ? [button("查看运行", () => context.openRun(o.runId!))] : []))) : [empty("尚无触发实例。保存草稿不生成运行；夏令时不存在的时间会跳过并通知。")])))) : [empty("暂无定时计划。先准备任务，再选择时间并保存草稿。") ]));
  }
  async function load() { const seq = ++request, latest = await api<TimedPage>("/api/timed-plans"); if (seq === request) { page = latest; render(); } }
  $("new-schedule").onclick = () => { void busy($<HTMLButtonElement>("new-schedule"), () => open()); };
  return { load, render };
}
