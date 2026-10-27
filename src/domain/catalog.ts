export interface ModelChoice { id: string; name: string; isDefault: boolean; efforts: string[] }
export interface ProjectChoice { id: string; name: string; roots: string[] }
export interface ThreadProjectBinding {
  source: "app_server" | "desktop_state";
  status: "assigned" | "unassigned" | "unknown" | "conflict";
  projectId: string | null;
}
export type DesktopCatalogStatus = "ready" | "missing" | "unsupported" | "source_mismatch" | "not_needed";
export interface ThreadChoice { id: string; name: string; projectId: string | null; projectKnown: boolean; cwd: string; updatedAt: number | null; projectBinding?: ThreadProjectBinding }
export interface ExecutionEnvironment {
  version: 1;
  mode: "folder" | "project" | "unassigned" | "resume";
  scope: string;
  connectionKey: string;
  projectId: string | null;
  projectKnown: boolean;
  roots: string[];
  cwd: string;
  writableRoots: string[];
  permissionsVerified: boolean;
  resumeAuthorization?: ResumeAuthorization;
}
export interface ResumeAuthorization {
  version: 1;
  threadId: string;
  context: string;
  cliVersion: string;
  sandbox: "read-only" | "workspace-write";
  readScope: "local-files";
  networkAccess: false;
  approvalPolicy: "on-request";
  approvalsReviewer: "user";
}
export interface ResumeAuthorizationPreview {
  context: string;
  cliVersion: string;
  writableCandidates: string[];
  allowedSandboxes: Array<"read-only" | "workspace-write">;
  readScope: "local-files";
}
export interface CatalogPage<T> { scope: string; items: T[]; nextCursor: string | null; desktopStatus?: DesktopCatalogStatus }
