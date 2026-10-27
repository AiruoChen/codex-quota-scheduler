import { resolve } from "node:path";

export function sidebarFixture(home: string) {
  const key = `local:${resolve(home)}`;
  return { "local-projects": { "legacy-project": { id: "legacy-project", name: "Synthetic project", rootPaths: [resolve("fixture-root")] } },
    "app-server-projects-migration-by-host": { [key]: { version: 1, projectsMigrated: true, threadAssignmentsMigrated: false, pendingThreadAssignmentIds: ["thread-1"] } },
    "app-server-project-id-by-legacy-project-id-by-host": { [key]: { "legacy-project": "official-project-1" } },
    "thread-project-assignments": { "thread-1": { projectKind: "local", projectId: "legacy-project" } },
    "thread-project-membership-host-ids": { "thread-1": "local", "unassigned-thread": "local", "unknown-thread": "remote-host" },
    "projectless-thread-ids": ["unassigned-thread"], unrelatedSecret: "PRIVATE_TOKEN_PATH_AND_PROMPT" };
}
