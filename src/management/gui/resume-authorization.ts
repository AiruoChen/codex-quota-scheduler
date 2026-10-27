import type { ResumeAuthorizationPreview } from "../../domain/catalog.js";
import { $, el } from "./dom.js";

/** Consent is scoped to the currently loaded chat and is cleared on every environment or policy change. */
export function resumeAuthorization(form: HTMLFormElement) {
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  let preview: ResumeAuthorizationPreview | undefined;
  const clearConsent = () => { field("resumeConsent").checked = false; field("resumeReadAll").checked = false; };
  function render() {
    clearConsent();
    const writing = field("sandbox").value === "workspace-write";
    $("resume-writable-roots").replaceChildren(...(writing ? preview?.writableCandidates ?? [] : []).map(path => {
      const checkbox = el("input", { type: "checkbox", value: path });
      checkbox.onchange = clearConsent;
      return el("label", {}, checkbox, path);
    }));
    $("resume-grant-status").textContent = !preview ? "请先读取会话环境；若始终不可用，请核对 CLI、管理策略及后台版本。"
      : !preview.allowedSandboxes.includes(field("sandbox").value as "read-only" | "workspace-write") ? "当前管理策略不允许所选文件权限。"
      : writing ? "请勾选允许写入的文件夹，必须包含上方会话实际工作目录。未勾选的文件夹不会获得写入授权。" : "只读：不授权文件写入。";
    field("resumeConsent").disabled = !preview; field("resumeReadAll").disabled = !preview;
  }
  return {
    clear() { preview = undefined; render(); },
    show(resume: boolean) { $("resume-authorization").hidden = !resume; },
    update(value: ResumeAuthorizationPreview | undefined) { preview = value; render(); },
    policyChanged: render,
    request() {
      if (!preview) throw new Error("尚未读取可验证的续接授权，请刷新目录；旧后台需安全重启后更新。");
      if (!field("resumeConsent").checked || !field("resumeReadAll").checked) throw new Error("请确认本机文件读取范围，并勾选“为此任务版本明确授权”。");
      if (!preview.allowedSandboxes.includes(field("sandbox").value as "read-only" | "workspace-write")) throw new Error("当前管理策略不允许所选文件权限。");
      return { confirmed: true, readAllLocalFiles: true, context: preview.context,
        writableRoots: [...$("resume-writable-roots").querySelectorAll<HTMLInputElement>("input:checked")].map(node => node.value) };
    },
  };
}
