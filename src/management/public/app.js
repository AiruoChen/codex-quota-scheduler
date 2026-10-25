const $ = (id) => document.getElementById(id);
const titles = { overview: "运行概览", tasks: "任务管理", runs: "运行记录", recovery: "异常与恢复", settings: "配置与日志" };
const labels = { queued: "已排队", waiting_quota: "等待额度", running: "执行中", succeeded: "已完成", failed: "失败", needs_attention: "待人工核对", cancelled: "已取消", available: "额度可用", blocked: "额度不足", unknown: "额度未知", paused: "已暂停" };
const reasons = { management_started: "服务启动后保持暂停", worker_started: "等待手动恢复队列", user_paused: "已手动暂停", not_enabled: "尚未启用自动队列", needs_attention: "存在待人工核对的运行", worker_stopping: "调度进程正在停止", runtime_stopping: "服务正在停止", scheduler_error: "调度异常，请检查运行记录", quota_available: "所有相关窗口均满足当前阈值", reserve_reached: "已达到保留额度阈值", quota_exhausted: "相关窗口额度已耗尽", unknown_quota: "缺少完整有效的额度信息", stale_quota: "读数已过期，等待完整查询", read_failed: "查询失败，等待重试", identity_unknown: "账户身份未知", missing_window: "缺少额度窗口" };
const events = { baseline: "已建立监控基线", identity_changed: "账户身份变化", clock_changed: "检测到时钟变化", quota_reset: "已确认额度窗口刷新", availability_changed: "额度可用状态变化", read_error: "额度查询失败", read_recovered: "额度查询已恢复" };
let csrf = "", state, view = "overview", editing = null, runId = null, offset = 0, configData, lastRunDetail;
let initialized = false, inFlight = false;
let runsRequest = 0, detailRequest = 0;
const seenJobs = new Map();
const busyButtons = new WeakSet();
const disabledButtons = new WeakMap();

function setDisabled(node, disabled) {
  disabledButtons.set(node, disabled);
  node.disabled = disabled || busyButtons.has(node);
}

// Dynamic content always uses text nodes, including prompts, output and remote messages.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined) node.setAttribute(key, String(value));
  }
  node.append(...children.filter((child) => child !== undefined && child !== null).map((child) => typeof child === "object" ? child : document.createTextNode(String(child))));
  return node;
}
const empty = (text) => el("div", { class: "empty" }, text);
const badge = (status) => el("span", { class: `badge ${["available", "succeeded"].includes(status) ? "good" : ["failed", "needs_attention", "blocked"].includes(status) ? "bad" : "warn"}` }, labels[status] ?? status);
const time = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const short = (id) => id.length > 18 ? id.slice(0, 8) + "…" + id.slice(-6) : id;
const button = (text, fn, cls = "") => el("button", { class: cls, onclick: (event) => busy(event.currentTarget, fn) }, text);

async function api(path, data) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...(data ? { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${result.error?.message ?? "请求失败"} (${result.error?.code ?? response.status})`);
  return result;
}
function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").className = "notice" + (error ? " danger" : "");
  $("notice").hidden = false;
}
async function busy(node, fn) {
  if (busyButtons.has(node)) return;
  busyButtons.add(node);
  node.disabled = true;
  try { await fn(); } catch (error) { notice(error.message, true); }
  finally {
    busyButtons.delete(node);
    node.disabled = disabledButtons.get(node) ?? false;
  }
}
async function act(action, data = {}, message) {
  const result = await api("/api/action", { action, ...data });
  if (message) notice(message);
  await refresh();
  return result;
}
function realButton(node) { setDisabled(node, state?.provider !== "codex"); if (node.disabled) node.title = "模拟模式不提交真实任务，请先修改 provider 并重启服务"; return node; }

function renderState() {
  const real = state.provider === "codex";
  $("source").textContent = real ? "真实账户 · CODEX" : "模拟模式 · MOCK";
  $("source").className = "badge " + (real ? "good" : "warn");
  const monitor = state.monitor;
  $("quota-caption").textContent = monitor?.snapshot?.account?.email
    ? `${monitor.snapshot.account.email} · ${monitor.snapshot.account.planType ?? "ChatGPT"} · ${reasons[monitor.availability.reason] ?? monitor.availability.reason}`
    : real ? (reasons[monitor?.availability.reason] ?? "等待完整查询") : "当前为模拟数据；真实执行与自动派发均不可用。";
  $("monitor-status").textContent = state.loop === "scheduler" ? "调度进程正在监控" : state.loop === "monitor" ? "持续监控中" : "监控已停止";
  const fresh = monitor?.availability.reason !== "stale_quota" && monitor?.availability.reason !== "read_failed";
  const buckets = monitor?.snapshot?.buckets ?? [];
  const cards = buckets.flatMap((bucket) => bucket.windows.map((window) => {
    const duration = window.durationMinutes;
    const label = duration === null ? "时长未知的窗口" : duration % 60 === 0 ? `${duration / 60} 小时窗口` : `${duration} 分钟窗口`;
    const value = fresh && duration > 0 && (window.resetsAt === null || Date.parse(window.resetsAt) > Date.parse(state.now)) ? window.remainingPercent : null;
    return el("article", { class: "quota-card" }, el("span", { class: "window-label" }, label), el("span", { class: "badge" }, bucket.name ?? bucket.id),
      el("div", { class: "quota-value" }, value === null ? "未知" : `${value}%`, el("small", {}, "剩余")),
      value === null ? el("div", { class: "subtle" }, "等待完整有效查询") : el("progress", { class: "quota-bar", max: 100, value, "aria-label": `${label}剩余额度` }),
      el("span", { class: "subtle" }, `${real ? "服务端" : "模拟"}刷新时间 · ${time(window.resetsAt)}`));
  }));
  $("quota-windows").replaceChildren(...(cards.length ? cards : [empty("尚无完整额度读数。查询失败会自动退避重试，不会被视为额度恢复。") ]));
  const scheduler = state.scheduler;
  $("scheduler-badge").textContent = scheduler.paused ? "已暂停" : "执行队列中";
  $("scheduler-badge").className = "badge " + (scheduler.paused ? "warn" : "good");
  $("scheduler-description").textContent = reasons[scheduler.reason] ?? (scheduler.paused ? "队列暂停，当前任务可继续完成。" : "按快照优先级串行执行已入队任务。 ");
  $("worker-status").textContent = scheduler.worker ? `调度进程在线 · PID ${scheduler.worker.pid}` : "调度进程未启动";
  $("trigger-mode").textContent = scheduler.worker ? (scheduler.worker.trigger === "refresh" ? "确认刷新后触发" : "额度可用时触发") : "启动后仍需恢复队列";
  document.querySelectorAll("[data-action]").forEach((node) => {
    const action = node.dataset.action;
    setDisabled(node, state.closing || (["resume", "scheduler-start"].includes(action) && !real)
      || (action === "monitor-start" && state.loop === "scheduler"));
  });
  const queue = scheduler.queue.filter((item) => ["queued", "waiting_quota", "running", "needs_attention"].includes(item.status));
  $("queue").replaceChildren(...(queue.length ? queue.map((item) => el("div", { class: "queue-item" }, el("div", {}, el("strong", {}, item.taskId), el("small", {}, `版本 ${item.revision} · 优先级 ${item.priority}`)), el("div", { class: "actions" }, badge(item.status), button("查看", () => openRun(item.runId)), ...(["queued", "waiting_quota"].includes(item.status) ? [button("移除", () => act("remove", { id: item.runId }, "已移除尚未提交的队列记录。"), "quiet")] : [])))) : [empty("队列为空。在任务管理中选择“加入队列”即可保存运行快照。") ]));
  $("monitor-events").replaceChildren(...(state.events.length ? [...state.events].reverse().slice(0, 8).map((event) => el("div", { class: "event-row" }, el("time", {}, time(event.createdAt)), el("span", {}, events[event.type] ?? event.type), event.data.code ? el("small", {}, event.data.code) : null)) : [empty("尚无监控事件") ]));
  $("updated-at").textContent = monitor ? `最近采样 ${time(monitor.observedAt)}` : "等待首次采样";
  $("footer-status").textContent = `${state.closing ? "服务正在停止" : "本地服务已连接"} · ${time(state.now)}`;
  const jobs = state.jobs.filter((job) => !["monitor", "scheduler"].includes(job.kind));
  $("jobs-panel").hidden = !jobs.length;
  $("jobs").replaceChildren(...jobs.slice(-8).reverse().map((job) => el("div", { class: "job-row" }, el("span", {}, `${job.kind} · ${job.code ?? (labels[job.detail] ?? job.detail) ?? ({ running: "处理中", succeeded: "操作已完成", failed: "操作失败" }[job.state])}`), job.runId ? button("查看记录", () => openRun(job.runId)) : "")));
  for (const job of jobs) {
    if (initialized && seenJobs.get(job.id) === "running" && job.state !== "running") notice(job.state === "failed" ? `后台操作未完成：${job.code}。请检查运行记录。` : "后台操作已结束，请查看运行记录中的最终状态。", job.state === "failed");
    seenJobs.set(job.id, job.state);
  }
  const report = state.recovery;
  $("recovery-report").replaceChildren(...(report.issues.length ? report.issues.map((issue) => el("div", { class: "issue" }, `${issue.code} · ${issue.runId ?? "进程状态"} · PID ${issue.ownerPid ?? "未知"}`)) : [empty("未发现需要修复的本地状态。")]), ...report.owners.map((owner) => el("p", { class: "hint" }, `${owner.kind} · PID ${owner.pid} · ${owner.state}`)));
  $("attention").replaceChildren(...(scheduler.attention.length ? scheduler.attention.map((id) => el("div", { class: "attention-row" }, el("div", {}, el("strong", {}, short(id)), el("small", {}, "请核对原会话和文件变更")), el("div", { class: "actions" }, button("查看", () => openRun(id)), realButton(button("只读核对", () => act("inspect", { id }, "已开始只读核对，结果见后台操作与运行详情。"))), realButton(button("应用已确认结果", () => confirmAction("reconcile", id, "读取准确回合并应用已确认的结果？不会重新发送任务。"))), button("确认已核对", () => confirmAction("acknowledge", id, "确认已人工核对会话与文件变更？此操作只解除调度阻塞，保留待处理状态。"))))) : [empty("暂无未确认的运行记录。") ]));
}

async function loadTasks() {
  const tasks = await api("/api/tasks");
  $("tasks-empty").hidden = tasks.length > 0;
  $("task-rows").replaceChildren(...tasks.map((task) => el("tr", {},
    el("td", {}, el("strong", {}, task.name), el("small", { title: task.projectDir }, `${task.id} · ${task.projectDir}`)), el("td", {}, `v${task.revision}`), el("td", {}, task.priority), el("td", {}, el("span", { class: `badge ${task.enabled ? "good" : ""}` }, task.enabled ? "启用" : "停用")),
    el("td", {}, el("div", { class: "actions" }, button("编辑", () => openTask(task.id)), button("加入队列", () => act("enqueue", { id: task.id }, "已保存此版本的队列快照。队列暂停时不会派发。")), realButton(button("执行", () => confirmAction("run", task.id, `现在手动执行“${task.name}”？执行将检查真实账户与额度。`))), button("归档", async () => { if (confirm(`归档“${task.name}”？历史记录会保留。`)) { await act("task-delete", { id: task.id, revision: task.revision }, "任务已归档。尚未派发的记录不会执行。"); } }, "quiet"))))));
}
async function loadRuns() {
  const request = ++runsRequest;
  const runs = await api(`/api/runs?offset=${offset}`);
  if (request !== runsRequest) return;
  $("runs-page").textContent = `第 ${offset / 50 + 1} 页`;
  setDisabled($("runs-prev"), offset === 0);
  setDisabled($("runs-next"), runs.length < 50);
  $("runs-empty").hidden = runs.length > 0;
  $("run-rows").replaceChildren(...runs.map((run) => el("tr", {}, el("td", {}, el("strong", {}, run.name), el("small", { title: run.id }, run.id)), el("td", {}, badge(run.status)), el("td", {}, `v${run.taskRevision}`), el("td", { class: "subtle" }, time(run.createdAt)), el("td", {}, button("查看详情", () => openRun(run.id))))));
}

async function openTask(id) {
  editing = id ? await api(`/api/task?id=${encodeURIComponent(id)}`) : null;
  const form = $("task-form");
  form.reset(); $("task-error").textContent = "";
  $("editor-title").textContent = editing ? `编辑任务 · v${editing.revision}` : "新建任务";
  for (const name of ["id", "name", "projectDir", "priority", "model"]) form.elements[name].value = editing?.[name] ?? (name === "priority" ? 10 : "");
  form.elements.id.disabled = !!editing;
  form.elements.enabled.checked = editing?.enabled ?? true;
  form.elements.prompt.value = editing?.promptSnapshot ?? "";
  form.elements.sandbox.value = editing?.execution?.sandbox ?? "read-only";
  form.elements.timeout.value = (editing?.execution?.timeoutMs ?? 900000) / 1000;
  form.elements.effort.value = editing?.execution?.effort ?? "";
  form.elements.session.value = editing?.session.mode ?? "new";
  form.elements.threadId.value = editing?.session.threadId ?? "";
  $("task-dialog").showModal();
}
$("task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget, fields = form.elements;
  await busy(form.querySelector("button[type=submit]"), async () => {
    try {
      const definition = { id: fields.id.value, name: fields.name.value, projectDir: fields.projectDir.value,
        priority: Number(fields.priority.value), enabled: fields.enabled.checked,
        session: fields.session.value === "new" ? { mode: "new" } : { mode: "resume", threadId: fields.threadId.value },
        execution: { sandbox: fields.sandbox.value, timeoutMs: Number(fields.timeout.value) * 1000, ...(fields.effort.value ? { effort: fields.effort.value } : {}) },
        ...(fields.model.value.trim() ? { model: fields.model.value.trim() } : {}), ...(editing ? { promptFile: editing.promptFile } : {}) };
      await api("/api/action", { action: "task-save", definition, prompt: fields.prompt.value, ...(editing ? { revision: editing.revision } : {}) });
      $("task-dialog").close(); notice("任务已保存为新版本；运行使用持久化指令快照。"); await loadTasks();
    } catch (error) { $("task-error").textContent = error.message; }
  });
});

async function openRun(id) {
  runId = id;
  await renderRun();
  if (runId !== id) return;
  if (!$("run-dialog").open) $("run-dialog").showModal();
}
async function renderRun() {
  if (!runId) return;
  const request = ++detailRequest;
  const detail = await api(`/api/run?id=${encodeURIComponent(runId)}`);
  if (request !== detailRequest) return;
  const serialized = JSON.stringify(detail);
  if (lastRunDetail === serialized) return;
  lastRunDetail = serialized;
  const openDetails = Array.from(document.querySelectorAll('#run-detail details')).map((node) => node.open);
  const run = detail.run;
  $("run-title").textContent = run.taskSnapshot.name;
  const fields = { "运行 ID": run.id, "任务版本": `v${run.taskRevision}`, "创建时间": time(run.createdAt), "完成时间": time(run.completedAt), "会话 ID": run.threadId ?? "未记录", "回合 ID": run.turnId ?? "未记录", "错误": run.error ?? "无" };
  const controls = [];
  if (["running", "queued", "waiting_quota"].includes(run.status)) controls.push(button("请求取消", () => confirmAction("cancel", run.id, "请求取消此运行？运行中任务需要等待远端终止确认。"), "danger-button"));
  if (["queued", "waiting_quota"].includes(run.status)) controls.push(realButton(button("手动启动此快照", () => confirmAction("run-start", run.id, "执行此持久化快照？它将使用记录中的任务版本与指令。"))));
  if (run.status === "needs_attention") controls.push(realButton(button("只读核对", () => act("inspect", { id: run.id }, "已开始只读核对。"))), realButton(button("应用已确认结果", () => confirmAction("reconcile", run.id, "读取准确回合并应用已确认结果？不会重新发送任务。"))));
  $("run-detail").replaceChildren(badge(run.status), el("dl", { class: "detail-grid" }, ...Object.entries(fields).flatMap(([key, value]) => [el("dt", {}, key), el("dd", {}, value)])), el("div", { class: "detail-actions" }, ...controls), el("h2", {}, "执行输出"), el("pre", {}, run.output || "尚无输出"), el("details", {}, el("summary", {}, "查看不可变指令快照"), el("pre", {}, run.promptSnapshot)), el("details", {}, el("summary", {}, "执行与恢复事件"), el("pre", {}, [...detail.events, ...detail.recovery].map((event) => `${event.createdAt} ${event.type} ${JSON.stringify(event.data)}`).join("\n") || "尚无事件")));
  document.querySelectorAll('#run-detail details').forEach((node, index) => { node.open = openDetails[index] ?? false; });
}
async function confirmAction(action, id, text) {
  if (!confirm(text)) return;
  const result = await act(action, { id, confirm: true }, action === "cancel" ? "已提交取消请求。最终状态以运行记录为准。" : "操作已提交，结果见运行记录与后台操作。");
  if (["run", "run-start"].includes(action) && result.runId) await openRun(result.runId);
  if ($("run-dialog").open) await renderRun();
}

async function loadConfig() {
  configData = await api("/api/config");
  $("active-config").textContent = JSON.stringify(configData.active, null, 2);
  $("config-difference").textContent = JSON.stringify(configData.active) === JSON.stringify(configData.saved) ? "配置已生效" : "存在待重启配置";
  fillConfigValue();
  await loadLogs();
}
function fillConfigValue() {
  const value = $("config-key").value.split(".").reduce((data, key) => data?.[key], configData?.saved);
  $("config-value").value = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
}
async function loadLogs() { $("runtime-logs").textContent = (await api("/api/logs")).text || "尚无日志"; }
$("config-key").addEventListener("change", fillConfigValue);
$("config-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void busy(event.currentTarget.querySelector("button[type=submit]"), async () => {
    let value = $("config-value").value;
    try { value = JSON.parse(value); } catch { /* String values are accepted by ConfigManager. */ }
    await act("config-set", { key: $("config-key").value, value }, "配置已校验、备份并保存。请重启服务使修改生效，重启后队列保持暂停。");
    await loadConfig();
  });
});
$("refresh-logs").onclick = (event) => busy(event.currentTarget, loadLogs);
$("repair").onclick = (event) => busy(event.currentTarget, async () => {
  if (confirm("显式修复已确认退出的进程与孤立记录？结果不明的任务仍需核对，不会重发。")) await act("repair", { confirm: true }, "已完成本地状态修复，请继续核对待处理的运行。");
});
$("new-task").onclick = (event) => busy(event.currentTarget, () => openTask());
$("runs-prev").onclick = (event) => busy(event.currentTarget, async () => { offset = Math.max(0, offset - 50); await loadRuns(); });
$("runs-next").onclick = (event) => busy(event.currentTarget, async () => { offset += 50; await loadRuns(); });
$("reload").onclick = () => location.reload();
document.querySelectorAll("[data-close]").forEach((node) => { node.onclick = () => $(node.dataset.close).close(); });
document.querySelectorAll("[data-action]").forEach((node) => { node.onclick = () => busy(node, async () => {
  if (node.dataset.action === "resume" && !confirm("恢复自动队列？额度满足时将执行显式入队的快照。")) return;
  if (node.dataset.action === "scheduler-stop" && !confirm("停止调度进程？当前执行会收到取消请求。")) return;
  await act(node.dataset.action, {}, "操作已提交；当前状态见页面。");
}); });

async function refresh() {
  state = await api("/api/state");
  renderState();
  if (view === "tasks" && !$("task-dialog").open) await loadTasks();
  if (view === "runs") await loadRuns();
  if ($("run-dialog").open) await renderRun();
  $("connection").hidden = true;
  initialized = true;
}
async function navigate() {
  view = location.hash.slice(1);
  if (!titles[view]) view = "overview";
  for (const [id, title] of Object.entries(titles)) {
    $(id).hidden = id !== view;
    const link = document.querySelector(`[data-view="${id}"]`);
    link.classList.toggle("active", id === view);
    if (id === view) { link.setAttribute("aria-current", "page"); $("page-title").textContent = title; $("breadcrumb").textContent = title; }
    else link.removeAttribute("aria-current");
  }
  try {
    if (!state) return;
    if (view === "tasks") await loadTasks();
    if (view === "runs") await loadRuns();
    if (view === "settings") await loadConfig();
  } catch (error) { notice(error.message, true); }
}
window.addEventListener("hashchange", navigate);
async function poll() {
  if (!inFlight && !document.hidden) {
    inFlight = true;
    try {
      if (!csrf) csrf = (await api("/api/bootstrap")).csrf;
      await refresh();
    } catch (error) {
      $("connection").textContent = `本地服务连接失败：${error.message}。重启服务后请重新加载页面。`;
      $("connection").hidden = false;
      $("quota-windows").replaceChildren(empty("连接已中断，当前额度未知。重新连接后将完整查询。"));
      $("footer-status").textContent = "连接中断 · 页面显示上次读数";
    } finally { inFlight = false; }
  }
  setTimeout(poll, 2000);
}
await navigate();
await poll();
if (view === "settings") await loadConfig().catch((error) => notice(error.message, true));
