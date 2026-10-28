import { readFile, writeFile } from "node:fs/promises";

// Render this manual's headings, links, lists, tables and fenced code without dependencies.
// Markdown is the source of truth; the generated HTML has no scripts or network dependencies.
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--check")) throw new Error("Usage: node scripts/build-user-manual.mjs [--check]");
const source = new URL("../docs/USER-MANUAL.md", import.meta.url);
const target = new URL("../docs/USER-MANUAL.html", import.meta.url);
const markdown = (await readFile(source, "utf8")).replace(/\r\n/g, "\n");
const lines = markdown.trimEnd().split("\n");
const edition = markdown.match(/^适用版本：(?:完整的 )?\*\*(.+?)\*\*/m)?.[1];
const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const references = [];
function inline(value) {
  const pattern = /`([^`]+)`|\[([^\]]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*/g;
  let text = "", start = 0;
  for (const match of value.matchAll(pattern)) {
    text += escape(value.slice(start, match.index));
    if (match[1] !== undefined) text += `<code>${escape(match[1])}</code>`;
    else if (match[2] !== undefined) {
      const href = match[3];
      if (!/^(?:https:\/\/[^\s]+|#[a-z0-9-]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:html|md))$/i.test(href)) throw new Error("MANUAL_LINK_UNSUPPORTED");
      references.push(href);
      text += `<a href="${escape(href)}">${inline(match[2])}</a>`;
    } else text += `<strong>${inline(match[4])}</strong>`;
    start = match.index + match[0].length;
  }
  return text + escape(value.slice(start));
}
const anchorPattern = /^<a id="([a-z0-9-]+)"><\/a>$/;
const anchors = new Set(), contents = [], blocks = [];
const cells = (line) => line.trim().slice(1, -1).split("|").map((cell) => cell.trim());
const special = (line) => /^(?:#{1,6} |```|<a id=|\||- |\d+\. )/.test(line);
for (let index = 0; index < lines.length;) {
  const line = lines[index];
  if (!line.trim()) { index++; continue; }
  const anchor = line.match(anchorPattern);
  if (anchor) {
    if (anchors.has(anchor[1]) || !/^## /.test(lines[index + 1] ?? "")) throw new Error("MANUAL_ANCHOR_INVALID");
    anchors.add(anchor[1]); contents.push({ id: anchor[1], label: lines[index + 1].slice(3) });
    blocks.push(`<a class="section-anchor" id="${anchor[1]}"></a>`); index++; continue;
  }
  const heading = line.match(/^(#{1,6}) (.+)$/);
  if (heading) { blocks.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); index++; continue; }
  if (line.startsWith("```")) {
    const language = line.slice(3).trim();
    if (!/^[a-z]*$/.test(language)) throw new Error("MANUAL_CODE_LANGUAGE_INVALID");
    const code = []; index++;
    while (index < lines.length && lines[index] !== "```") code.push(lines[index++]);
    if (index === lines.length) throw new Error("MANUAL_CODE_UNCLOSED");
    blocks.push(`<pre aria-label="${language === "powershell" ? "可复制的 PowerShell 命令" : "可复制的示例文字"}"><code>${escape(code.join("\n"))}</code></pre>`);
    index++; continue;
  }
  if (line.startsWith("|")) {
    const header = cells(line), separator = lines[index + 1];
    if (!separator || !cells(separator).every((cell) => /^:?-+:?$/.test(cell)) || cells(separator).length !== header.length) throw new Error("MANUAL_TABLE_INVALID");
    const rows = []; index += 2;
    while (index < lines.length && lines[index].startsWith("|")) {
      const row = cells(lines[index++]);
      if (row.length !== header.length) throw new Error("MANUAL_TABLE_WIDTH_INVALID");
      rows.push(`<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`);
    }
    blocks.push(`<div class="table-scroll" role="region" aria-label="对照表" tabindex="0"><table><thead><tr>${header.map((cell) => `<th scope="col">${inline(cell)}</th>`).join("")}</tr></thead><tbody>\n${rows.join("\n")}\n</tbody></table></div>`); continue;
  }
  const item = line.match(/^(- |\d+\. )(.+)$/);
  if (item) {
    const ordered = item[1] !== "- ", rows = [], start = ordered ? Number.parseInt(item[1], 10) : 1;
    while (index < lines.length) {
      const next = lines[index].match(ordered ? /^\d+\. (.+)$/ : /^- (.+)$/);
      if (!next) break;
      rows.push(`<li>${inline(next[1])}</li>`); index++;
    }
    const tag = ordered ? "ol" : "ul";
    blocks.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>\n${rows.join("\n")}\n</${tag}>`); continue;
  }
  const paragraph = [line]; index++;
  while (index < lines.length && lines[index].trim() && !special(lines[index])) paragraph.push(lines[index++]);
  blocks.push(`<p>${inline(paragraph.join(" "))}</p>`);
}
if (!edition || !contents.length) throw new Error("MANUAL_STRUCTURE_INVALID");
for (const href of references) if (href.startsWith("#") && !anchors.has(href.slice(1))) throw new Error("MANUAL_LINK_TARGET_MISSING");
for (const href of new Set(references.filter((value) => !value.startsWith("#") && !value.startsWith("https://")))) {
  if (href !== "USER-MANUAL.html") await readFile(new URL(href, source));
}
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Codex 任务助手 · 零基础用户使用手册</title>
<!-- Generated from USER-MANUAL.md with node scripts/build-user-manual.mjs. -->
<style>
:root{color-scheme:light;--ink:#172b3a;--muted:#526775;--accent:#126b64;--line:#dce6e9;--paper:#fff;--back:#f2f6f7}
*{box-sizing:border-box}html{scroll-padding-top:24px}body{margin:0;background:var(--back);color:var(--ink);font:16px/1.85 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;overflow-wrap:anywhere}
a{color:var(--accent);text-underline-offset:3px}a:hover{text-decoration-thickness:2px}a:focus-visible,summary:focus-visible,.table-scroll:focus-visible{outline:3px solid #e9aa3f;outline-offset:4px}
.skip{position:fixed;top:-80px;left:16px;background:white;padding:8px 16px;z-index:5}.skip:focus{top:12px}.layout{display:grid;grid-template-columns:270px minmax(0,970px);gap:30px;max-width:1330px;margin:auto;padding:24px}
aside{position:sticky;top:24px;align-self:start;height:calc(100vh - 48px);overflow:auto;padding:18px 12px 20px 0}.brand{font-size:13px;letter-spacing:.12em;color:var(--accent);font-weight:750}.aside-title{font-size:24px;font-weight:750;margin:4px 0 12px}.aside-hint{font-size:13px;color:var(--muted);margin:0 0 18px}nav a{display:block;font-size:14px;text-decoration:none;padding:5px 9px;border-radius:6px}nav a:hover{background:#e2eeeb}nav .appendix{color:var(--muted)}
main{min-width:0;background:var(--paper);padding:44px 48px 60px;border:1px solid var(--line);border-radius:14px;box-shadow:0 8px 40px #14323d06}.edition{display:inline-block;font-size:12px;font-weight:700;color:var(--accent);background:#e8f3ef;padding:4px 12px;border-radius:20px}h1{font-size:34px;line-height:1.35;letter-spacing:-.02em;margin:18px 0 24px;text-wrap:balance}h2{font-size:25px;line-height:1.5;padding-top:12px;margin:36px 0 18px;border-top:1px solid var(--line)}h3{font-size:19px;line-height:1.6;margin:28px 0 12px}p{margin:14px 0}li{margin:8px 0}ul,ol{padding-left:1.7em}strong{color:#102e38}
code{font:0.9em/1.7 Consolas,"Cascadia Code",monospace;background:#eef3f4;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#162f3b;color:#eef6f7;border-radius:8px;padding:18px 20px;font-size:14px;line-height:1.8}pre code{color:inherit;background:none;padding:0;border-radius:0}
.table-scroll{overflow-x:auto;margin:20px 0;border:1px solid var(--line);border-radius:8px}table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.75}th,td{text-align:left;vertical-align:top;padding:12px 14px;border-bottom:1px solid var(--line)}th{background:#edf4f3;font-weight:700;color:#1e4948}tbody tr:last-child td{border-bottom:0}tbody tr:nth-child(even){background:#f8fafb}th:first-child{min-width:105px}td:first-child{min-width:105px}tr{break-inside:avoid}
.section-anchor{display:block;scroll-margin-top:24px}article>h2:first-of-type+ul{columns:2;column-gap:24px;font-size:14px}article>h2:first-of-type+ul li{break-inside:avoid}.reading-tip{font-size:13px;color:var(--muted);margin-top:10px}.endnote{border-top:1px solid var(--line);padding-top:16px;margin-top:36px;color:var(--muted);font-size:13px}
@media(max-width:1000px){.layout{display:block;padding:16px}aside{position:static;height:auto;max-height:245px;padding:4px 8px 16px;margin-bottom:18px}.aside-title{font-size:21px}.aside-hint{margin-bottom:8px}nav{display:grid;grid-template-columns:1fr 1fr}main{padding:28px 26px}h1{font-size:29px}}
@media(max-width:560px){body{font-size:15px}.layout{padding:10px}main{padding:24px 18px;border-radius:10px}h1{font-size:27px}h2{font-size:22px}h3{font-size:18px}article>h2:first-of-type+ul{columns:1}th,td{padding:10px;min-width:110px}table{min-width:460px}nav a{font-size:12px}pre{padding:14px}}
@media print{@page{size:A4;margin:17mm 15mm}body{background:white;color:#111;font-size:10.5pt;line-height:1.65}.layout{display:block;padding:0;max-width:none}aside,.skip,.reading-tip{display:none}main{border:0;box-shadow:none;border-radius:0;padding:0}h1{font-size:24pt}h2{font-size:17pt;margin-top:24pt;break-after:avoid}h3{font-size:13pt;break-after:avoid}p,li{orphans:3;widows:3}a{color:#163c46}pre{background:#f0f3f4;color:#111;border:1px solid #d5dfe2;white-space:pre-wrap;break-inside:avoid;font-size:9pt;padding:10pt}.table-scroll{overflow:visible;border-radius:0;break-inside:auto}table{min-width:0;font-size:9pt;line-height:1.5}thead{display:table-header-group}th,td{padding:7pt;min-width:0}th:first-child,td:first-child{min-width:0}.edition{-webkit-print-color-adjust:exact;print-color-adjust:exact}.section-anchor{scroll-margin-top:0}}
</style>
</head>
<body>
<a class="skip" href="#manual">跳到使用手册正文</a>
<div class="layout">
<aside aria-label="章节目录"><div class="brand">CODEX QUOTA SCHEDULER</div><div class="aside-title">用户使用手册</div><p class="aside-hint">先按第一次使用路线完成练习，遇到问题再查对应章节。</p><nav aria-label="手册章节">
${contents.map((item) => `<a${item.id.startsWith("appendix") ? ' class="appendix"' : ""} href="#${item.id}">${escape(item.label)}</a>`).join("\n")}
</nav></aside>
<main id="manual"><span class="edition">${escape(edition)}</span><p class="reading-tip">本文件可离线阅读。按 Ctrl + F 查找关键词；按 Ctrl + P 打印或另存为 PDF。窄屏表格可左右滑动。</p><article>
${blocks.join("\n")}
</article><p class="endnote">手册为说明文件，不会执行命令、联网读取账户或提交任务。请以客户端实际版本与实时状态为准。</p></main>
</div>
</body>
</html>
`;
if (args[0] === "--check") {
  if ((await readFile(target, "utf8")) !== html) throw new Error("MANUAL_HTML_OUTDATED: run node scripts/build-user-manual.mjs");
} else await writeFile(target, html, "utf8");
console.log(JSON.stringify({ manual: "docs/USER-MANUAL.html", sections: contents.length, checked: args[0] === "--check" }));
