import type { CatalogPage, ModelChoice, ProjectChoice, ThreadChoice, ExecutionEnvironment } from "../../domain/catalog.js";
import type { StoredTask } from "../../domain/task.js";
import { api } from "./api.js";
import { $, el } from "./dom.js";

/** Catalog state belongs to one open editor. No account metadata is persisted in browser storage. */
export function taskCatalog(form: HTMLFormElement, provider: () => "codex" | "mock" | undefined) {
  const select = (name: string) => form.elements.namedItem(name) as HTMLSelectElement;
  let epoch = 0, threadRequest = 0, scope = "", cursor: string | null = null;
  let source: "codex" | "mock" | "unknown" = "unknown";
  const sourceKind = () => source;
  let models: ModelChoice[] = [], projects: ProjectChoice[] = [], writes: string[] = [];
  const status = (message: string) => { $("catalog-status").textContent = message; };
  function options(name: string, entries: Array<[string, string]>, placeholder: string, keep = true) {
    const node = select(name), old = keep ? node.value : "";
    node.replaceChildren(el("option", { value: "" }, placeholder), ...entries.map(([value, label]) => el("option", { value }, label)));
    if (old && !entries.some(([value]) => value === old)) node.append(el("option", { value: old }, `${old}（尚未验证）`));
    node.value = old;
  }
  function efforts(preserve = true) {
    options("effort", (models.find(model => model.id === select("model").value)?.efforts ?? []).map(value => [value, value]), "使用模型默认强度", preserve);
  }
  function roots() {
    const selected = projects.find(project => project.id === select("projectId").value);
    options("projectCwd", (selected?.roots ?? []).map(path => [path, path]), "请选择本次工作目录");
    const container = $("writable-roots");
    container.hidden = select("session").value === "resume" || select("sandbox").value !== "workspace-write" || select("targetMode").value !== "project";
    container.replaceChildren(el("p", {}, "明确授权可写文件夹（工作区写入模式必须包含本次工作目录）："), ...(selected?.roots ?? []).map(path => {
      const checkbox = el("input", { type: "checkbox", value: path }); checkbox.checked = writes.includes(path);
      checkbox.onchange = () => { writes = [...container.querySelectorAll<HTMLInputElement>("input:checked")].map(node => node.value); };
      return el("label", {}, checkbox, path);
    }));
  }
  function layout() {
    const resume = select("session").value === "resume", mode = select("targetMode").value;
    select("targetMode").closest("label")!.hidden = resume;
    select("projectId").closest("label")!.hidden = !resume && mode !== "project";
    select("threadId").closest("label")!.hidden = !resume;
    $("project-directory-row").hidden = !resume && mode !== "folder";
    const directory = form.elements.namedItem("projectDir") as HTMLInputElement;
    directory.readOnly = resume; directory.required = !resume && mode === "folder";
    $("choose-project").hidden = resume;
    $("project-cwd-row").hidden = resume || mode !== "project";
    roots();
  }
  async function pages<T>(kind: string, current: number): Promise<T[]> {
    const items: T[] = [], seen = new Set<string>(); let after: string | null = null;
    do {
      const page: CatalogPage<T> & { source: "codex" | "mock" } = await api(`/api/catalog/${kind}${after ? `?cursor=${encodeURIComponent(after)}` : ""}`);
      if (current !== epoch) return [];
      if (scope && scope !== page.scope) throw new Error("账户或来源发生变化，请重新加载目录。");
      scope = page.scope; source = page.source; items.push(...page.items); after = page.nextCursor;
      if (after && (seen.has(after) || seen.size >= 50)) throw new Error("目录分页异常，请稍后重试。");
      if (after) seen.add(after);
    } while (after);
    return items;
  }
  async function threads(append = false) {
    const current = ++threadRequest, editor = epoch;
    const params = new URLSearchParams({ scope, projectId: select("projectId").value });
    if (append && cursor) params.set("cursor", cursor);
    const page = await api<CatalogPage<ThreadChoice>>(`/api/catalog/threads?${params}`);
    if (editor !== epoch || current !== threadRequest) return;
    if (page.scope !== scope) throw new Error("账户或来源已改变，请重新加载。");
    if (!append) options("threadId", [], "请选择会话", false);
    const existing = new Set([...select("threadId").options].map(option => option.value));
    for (const item of page.items) if (!existing.has(item.id)) select("threadId").append(el("option", { value: item.id }, `${item.name} · ${item.id.slice(0, 8)}${item.projectKnown ? "" : " · 归属未知"}`));
    cursor = page.nextCursor; $("threads-more").hidden = !cursor;
  }
  async function environment() {
    const id = select("threadId").value, current = ++threadRequest, editor = epoch;
    if (!id) return;
    const result = await api<{ scope: string; environment: ExecutionEnvironment; limitation: string }>(`/api/catalog/environment?${new URLSearchParams({ threadId: id, scope })}`);
    if (editor !== epoch || current !== threadRequest) return;
    if (result.scope !== scope) throw new Error("目录账户已改变。");
    (form.elements.namedItem("projectDir") as HTMLInputElement).value = result.environment.cwd;
    $("task-environment").textContent = `实际工作目录：${result.environment.cwd}\n关联文件夹：${result.environment.roots.join("；") || "未提供"}\n${result.limitation}`;
  }
  async function refresh() {
    const current = ++epoch; threadRequest++; scope = ""; source = "unknown"; status("正在读取当前 Codex 的模型和官方项目…");
    models = await pages<ModelChoice>("models", current); if (current !== epoch) return;
    options("model", models.map(model => [model.id, `${model.name}${model.isDefault ? "（默认）" : ""}`]), "使用 Codex 默认模型"); efforts();
    try {
      projects = await pages<ProjectChoice>("projects", current); if (current !== epoch) return;
      options("projectId", [["none", "无项目（仅显示已确认无归属的会话）"], ...projects.map(project => [project.id, project.name] as [string, string])], "请选择官方项目");
      roots(); status(sourceKind() === "mock" ? "模拟模式未读取真实目录。可用本地文件夹创建练习任务。" : models.length ? "已读取真实目录。项目文件夹不代表完整文件权限；继续原生会话须先通过完整权限校验。" : "当前账户模型目录为空，请核对连接后重试。");
      if (select("session").value === "resume") await threads();
    } catch (error) { if (current === epoch) status(error instanceof Error ? error.message : "项目查询失败，已加载的模型仍可使用。"); }
  }
  function report(operation: () => Promise<void>) { void operation().catch(error => status(error instanceof Error ? error.message : "目录读取失败，请重试。")); }
  select("model").onchange = () => efforts(false);
  for (const name of ["session", "targetMode"]) select(name).onchange = () => { threadRequest++; layout(); if (select("session").value === "resume" && scope) report(() => threads()); };
  select("projectId").onchange = () => { writes = []; select("projectCwd").value = ""; roots(); if (select("session").value === "resume") { (form.elements.namedItem("projectDir") as HTMLInputElement).value = ""; $("task-environment").textContent = ""; report(() => threads()); } };
  select("threadId").onchange = () => report(environment);
  select("sandbox").onchange = layout;
  $("catalog-refresh").onclick = () => report(refresh);
  $("threads-more").onclick = () => report(() => threads(true));
  return {
    async open(task: StoredTask | null) {
      writes = task?.environment?.writableRoots.slice() ?? []; models = []; projects = []; cursor = null; scope = "";
      select("targetMode").value = task?.environment?.mode === "project" ? "project" : task?.environment?.mode === "unassigned" ? "unassigned" : "folder";
      options("model", task?.model ? [[task.model, task.model]] : [], "使用 Codex 默认模型", false); select("model").value = task?.model ?? "";
      options("effort", task?.execution?.effort ? [[task.execution.effort, task.execution.effort]] : [], "使用模型默认强度", false); select("effort").value = task?.execution?.effort ?? "";
      options("projectId", task?.environment?.projectId ? [[task.environment.projectId, "原项目（待核实）"]] : [], "请选择官方项目", false);
      select("projectId").value = task?.environment?.projectId ?? (task?.environment?.projectKnown ? "none" : "");
      $("task-environment").textContent = ""; $("threads-more").hidden = true; layout();
      const loading = refresh(), current = epoch; await loading; if (current !== epoch) return;
      if (task?.environment?.mode === "project") select("projectCwd").value = task.environment.cwd;
      if (task?.session.mode === "resume") { options("threadId", [[task.session.threadId, "原会话（待核实）"]], "请选择会话", false); select("threadId").value = task.session.threadId; await environment(); }
    },
    target(): Record<string, unknown> {
      const mode = select("session").value === "resume" ? "resume" : select("targetMode").value;
      if (mode === "folder") {
        // Mock folders remain entirely local. Real selections carry the account scope back to the server.
        if (provider() === "mock" || source === "mock") return {};
        if (source !== "codex" || !scope) throw new Error("请先成功读取当前账户目录；读取失败时不会保存未知环境。");
        const cwd = (form.elements.namedItem("projectDir") as HTMLInputElement).value;
        return { scope, target: { mode, cwd, writableRoots: select("sandbox").value === "workspace-write" ? [cwd] : [] } };
      }
      if (!scope) throw new Error("请先成功读取真实目录。");
      if (mode === "resume") { if (!select("threadId").value) throw new Error("请选择会话。"); return { scope, target: { mode, threadId: select("threadId").value } }; }
      if (mode === "project" && (!select("projectId").value || select("projectId").value === "none" || !select("projectCwd").value)) throw new Error("请选择官方项目及本次工作目录。");
      return { scope, target: { mode, projectId: mode === "project" ? select("projectId").value : null, cwd: mode === "project" ? select("projectCwd").value : "", writableRoots: writes } };
    },
    close() { epoch++; threadRequest++; scope = ""; },
  };
}
