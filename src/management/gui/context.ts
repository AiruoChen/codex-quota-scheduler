import type { ManagementState } from "../contracts.js";
import { setDisabled } from "./dom.js";
export interface UiContext {
  state(): ManagementState | null;
  connected(): boolean;
  act(action: string, data?: Record<string, unknown>, message?: string): Promise<unknown>;
  refresh(): Promise<void>;
  openRun(id: string): Promise<void>;
  confirmAction(action: string, id: string, text: string): Promise<void>;
}
export function realButton(node: HTMLButtonElement, context: UiContext) {
  setDisabled(node, !context.connected() || context.state()?.closing === true || context.state()?.provider !== "codex");
  if (node.disabled) node.title = "真实执行需要已连接的真实来源；模拟模式不发送任务";
  return node;
}
