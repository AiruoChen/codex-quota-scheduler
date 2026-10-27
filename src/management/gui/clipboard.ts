/** User-initiated text copy. No filesystem or Electron IPC access. */
export async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return; } catch { /* Sandboxed clients may deny the permission. */ }
  const active = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const buffer = document.createElement("textarea"); buffer.className = "copy-buffer"; buffer.value = text;
  buffer.setAttribute("aria-hidden", "true"); document.body.append(buffer); buffer.select();
  let copied = false;
  try { copied = document.execCommand("copy"); }
  finally {
    buffer.remove(); if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); for (const range of ranges) if (range.startContainer.isConnected && range.endContainer.isConnected) selection.addRange(range); }
  }
  if (!copied) throw new Error("复制未完成，请选择文本后按 Ctrl+C。");
}
