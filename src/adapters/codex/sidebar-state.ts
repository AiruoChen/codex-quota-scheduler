import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DesktopCatalogStatus } from "../../domain/catalog.js";
import { isRecord } from "../../shared/validation.js";
import type { CodexOptions } from "./launcher.js";

export interface SidebarSnapshot {
  revision: string;
  projectIds: ReadonlySet<string>;
  serverIds: ReadonlyMap<string, string>;
  assignments: ReadonlyMap<string, { kind: string; projectId: string }>;
  memberships: ReadonlyMap<string, string>;
  projectless: ReadonlySet<string>;
  pending: ReadonlySet<string>;
}
export type SidebarState = { status: "ready"; snapshot: SidebarSnapshot } | { status: Exclude<DesktopCatalogStatus, "ready"> };
export type SidebarReader = (options: CodexOptions) => Promise<SidebarState>;
const maxBytes = 8 * 1024 * 1024;
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const entries = (value: unknown): Array<[string, unknown]> | null => isRecord(value) && Object.keys(value).length <= 50000 ? Object.entries(value) : null;
const ids = (value: unknown): string[] | null => Array.isArray(value) && value.length <= 50000 && value.every(id) ? value : null;

/** Whitelist only the confirmed v1 desktop schema. Unrelated state, names, roots and contents never leave this module. */
export function parseSidebarState(value: unknown, home: string): SidebarState {
  if (!isRecord(value)) return { status: "unsupported" };
  const key = `local:${resolve(home)}`;
  const migrations = value["app-server-projects-migration-by-host"], hostMaps = value["app-server-project-id-by-legacy-project-id-by-host"];
  if (!isRecord(migrations) || !isRecord(hostMaps)) return { status: "unsupported" };
  if (!Object.hasOwn(migrations, key) || !Object.hasOwn(hostMaps, key)) return { status: "source_mismatch" };
  const migration = migrations[key];
  if (!isRecord(migration) || migration.version !== 1 || migration.projectsMigrated !== true || typeof migration.threadAssignmentsMigrated !== "boolean") return { status: "unsupported" };
  if (migration.threadAssignmentsMigrated) return { status: "not_needed" };
  const pending = ids(migration.pendingThreadAssignmentIds), projectless = ids(value["projectless-thread-ids"]);
  const projects = entries(value["local-projects"]), maps = entries(hostMaps[key]), assignments = entries(value["thread-project-assignments"]), memberships = entries(value["thread-project-membership-host-ids"]);
  if (!pending || !projectless || !projects || !maps || !assignments || !memberships) return { status: "unsupported" };
  const projectIds = new Set<string>();
  for (const [legacyId, project] of projects) {
    if (!id(legacyId) || !isRecord(project) || project.id !== legacyId) return { status: "unsupported" };
    projectIds.add(legacyId);
  }
  const serverIds = new Map<string, string>();
  for (const [legacyId, serverId] of maps) {
    if (!id(legacyId) || !id(serverId)) return { status: "unsupported" };
    serverIds.set(legacyId, serverId);
  }
  const linked = new Map<string, { kind: string; projectId: string }>();
  for (const [threadId, assignment] of assignments) {
    if (!id(threadId) || !isRecord(assignment) || !id(assignment.projectId) || !id(assignment.projectKind)) return { status: "unsupported" };
    linked.set(threadId, { kind: assignment.projectKind, projectId: assignment.projectId });
  }
  const hosts = new Map<string, string>();
  for (const [threadId, host] of memberships) {
    if (!id(threadId) || !id(host)) return { status: "unsupported" };
    hosts.set(threadId, host);
  }
  // Hash only membership-related projection; harmless desktop preference changes do not invalidate paging.
  const revision = createHash("sha256").update(JSON.stringify([key, projects.map(([key]) => key).sort(), [...serverIds].sort(), [...linked].sort(), [...hosts].sort(), [...pending].sort(), [...projectless].sort()])).digest("hex");
  return { status: "ready", snapshot: { revision, projectIds, serverIds, assignments: linked, memberships: hosts, pending: new Set(pending), projectless: new Set(projectless) } };
}

/** Read-only and bounded, from this connection's exact Codex home. Never scan other profiles or write migration markers. */
export const readSidebarState: SidebarReader = async (options) => {
  // Custom arguments may route app-server to a different host or override its storage. Do not borrow local state.
  if (options.args.length) return { status: "source_mismatch" };
  const home = resolve(options.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  if (process.env.CODEX_SQLITE_HOME && resolve(process.env.CODEX_SQLITE_HOME) !== home) return { status: "source_mismatch" };
  try {
    const canonicalHome = await realpath(home), file = join(canonicalHome, ".codex-global-state.json");
    const link = await lstat(file);
    if (!link.isFile() || link.isSymbolicLink() || await realpath(file) !== file) return { status: "unsupported" };
    const handle = await open(file, "r");
    try {
      const before = await handle.stat();
      // Windows reports different device identifiers for path and handle stats; inode identity still agrees.
      if (!before.isFile() || before.size < 2 || before.size > maxBytes || before.ino !== link.ino
        || process.platform !== "win32" && before.dev !== link.dev) return { status: "unsupported" };
      const buffer = Buffer.alloc(before.size + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!part.bytesRead) break;
        bytesRead += part.bytesRead;
      }
      const after = await handle.stat(), current = await lstat(file);
      if (bytesRead !== before.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs
        || current.isSymbolicLink() || current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs) return { status: "unsupported" };
      return parseSidebarState(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")), home);
    } finally { await handle.close(); }
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsupported" };
  }
};
