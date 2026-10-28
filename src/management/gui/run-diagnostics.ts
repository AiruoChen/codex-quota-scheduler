import { api } from "./api.js";
import { button, el, notice } from "./dom.js";
import { copyText } from "./clipboard.js";

export function diagnosticControls(runId: string): HTMLElement {
  const output = el("pre", { class: "run-output", tabindex: "0" }, "点击查看，生成该运行的详细脱敏诊断。旧记录无法补回未保存的响应。");
  let serialized = "", pending: Promise<string> | undefined;
  const load = () => pending ??= api<unknown>(`/api/run/diagnostics?id=${encodeURIComponent(runId)}`).then(data => {
    serialized = JSON.stringify(data, null, 2); output.textContent = serialized; return serialized;
  }).finally(() => { pending = undefined; });
  return el("details", { "data-run-diagnostics": "true" }, el("summary", {}, "详细诊断日志（脱敏）"),
    el("p", { class: "hint" }, "包含发送证据、授权期望值、服务端权限结构、请求与响应顺序及具体失败项。路径和会话使用本次运行内的代号；不含凭据、任务正文或私人目录。"),
    el("div", { class: "actions wrap" }, button("查看／刷新详细诊断", async () => { await load(); }),
      button("复制诊断日志", async () => { await copyText(serialized || await load()); notice("详细脱敏诊断已复制。"); }),
      button("下载诊断 JSON", async () => {
        const text = await load(), url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
        const link = el("a", { href: url, download: `codex-run-${/^[a-f0-9-]{36}$/.test(runId) ? runId : "report"}-diagnostics.json` });
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      })), output);
}
