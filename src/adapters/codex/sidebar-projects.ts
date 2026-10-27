import type { ThreadChoice, ThreadProjectBinding } from "../../domain/catalog.js";
import { AppError } from "../../shared/errors.js";
import { isRecord } from "../../shared/validation.js";
import type { SidebarSnapshot } from "./sidebar-state.js";

/** Display association only. The protocol projectId and all execution permissions remain untouched. */
export function bindSidebarProject(thread: ThreadChoice, snapshot: SidebarSnapshot, liveProjects: ReadonlySet<string>): ThreadChoice {
  const binding = (status: ThreadProjectBinding["status"], projectId: string | null = null): ThreadChoice => ({ ...thread, projectBinding: { source: "desktop_state", status, projectId } });
  if (thread.projectKnown && thread.projectId !== null) return { ...thread, projectBinding: { source: "app_server", status: "assigned", projectId: thread.projectId } };
  const assignment = snapshot.assignments.get(thread.id), projectless = snapshot.projectless.has(thread.id);
  if (assignment && projectless) return binding("conflict");
  if (snapshot.memberships.get(thread.id) !== "local") return binding("unknown");
  if (projectless && !assignment) return binding("unassigned");
  if (!assignment) return binding("unknown");
  if (assignment.kind !== "local" || !snapshot.pending.has(thread.id) || !snapshot.projectIds.has(assignment.projectId)) return binding("unknown");
  const serverId = snapshot.serverIds.get(assignment.projectId);
  if (!serverId || !liveProjects.has(serverId)) return binding("unknown");
  const aliases = [...snapshot.serverIds].filter(([, value]) => value === serverId);
  if (aliases.length !== 1) return binding("conflict");
  return binding("assigned", serverId);
}

export function displayedProject(thread: ThreadChoice): string | null | undefined {
  if (thread.projectBinding) return thread.projectBinding.status === "assigned" ? thread.projectBinding.projectId : thread.projectBinding.status === "unassigned" ? null : undefined;
  return thread.projectKnown ? thread.projectId : undefined;
}

export function sidebarCursor(cursor: string, scope: string, filter: string | undefined, revision: string): string {
  const value = "sidebar-v1:" + Buffer.from(JSON.stringify({ scope, filter: filter ?? "", revision, cursor })).toString("base64url");
  if (value.length > 4000) throw new AppError("CODEX_PROTOCOL_ERROR", "会话分页标识过长，请缩小查询范围。");
  return value;
}
export function readSidebarCursor(value: string, scope: string, filter: string | undefined, revision: string): string {
  try {
    if (!value.startsWith("sidebar-v1:") || value.length > 4000) throw new Error("Invalid cursor");
    const parsed: unknown = JSON.parse(Buffer.from(value.slice(11), "base64url").toString("utf8"));
    if (!isRecord(parsed) || parsed.scope !== scope || parsed.filter !== (filter ?? "") || parsed.revision !== revision
      || typeof parsed.cursor !== "string" || !parsed.cursor || parsed.cursor.length > 3000) throw new Error("Cursor changed");
    return parsed.cursor;
  } catch { throw new AppError("CATALOG_CHANGED", "会话分组、账户或筛选条件已变化，请重新读取第一页。"); }
}
