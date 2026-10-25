export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node as T;
}
type Child = Node | string | number | null | undefined;
type Attributes = Record<string, string | number | boolean | undefined | ((event: Event) => unknown)>;
const busyButtons = new WeakSet<HTMLButtonElement>();
const disabledButtons = new WeakMap<HTMLButtonElement, boolean>();

/** All untrusted content is appended as text, never HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attributes = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value !== undefined) node.setAttribute(key, String(value));
  }
  node.append(...children.filter((child): child is Node | string | number => child !== undefined && child !== null)
    .map((child) => child instanceof Node ? child : document.createTextNode(String(child))));
  return node;
}
export const empty = (text: string) => el("div", { class: "empty" }, text);
export const time = (value: string | null | undefined) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
export const short = (id: string) => id.length > 18 ? id.slice(0, 8) + "…" + id.slice(-6) : id;
export function notice(message: string, error = false) {
  $("notice").textContent = message; $("notice").className = "notice" + (error ? " danger" : ""); $("notice").hidden = false;
}
export function setDisabled(node: HTMLButtonElement, disabled: boolean) {
  disabledButtons.set(node, disabled); node.disabled = disabled || busyButtons.has(node);
}
export async function busy(node: HTMLButtonElement, fn: () => Promise<unknown>) {
  if (busyButtons.has(node)) return;
  busyButtons.add(node); node.disabled = true; node.setAttribute("aria-busy", "true");
  try { await fn(); } catch (error) { notice(error instanceof Error ? error.message : "操作失败", true); }
  finally { busyButtons.delete(node); node.disabled = disabledButtons.get(node) ?? false; node.removeAttribute("aria-busy"); }
}
export const button = (text: string, fn: () => Promise<unknown>, cls = "") => {
  const node = el("button", { type: "button", class: cls }, text);
  node.onclick = () => { void busy(node, fn); }; return node;
};
export function showDialog(id: string) {
  const dialog = $<HTMLDialogElement>(id);
  if (!dialog.open) dialog.showModal();
}
