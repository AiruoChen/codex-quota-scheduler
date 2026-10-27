export interface ModelChoice { id: string; name: string; isDefault: boolean; efforts: string[] }
export interface ProjectChoice { id: string; name: string; roots: string[] }
export interface ThreadChoice { id: string; name: string; projectId: string | null; projectKnown: boolean; cwd: string; updatedAt: number | null }
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
}
export interface CatalogPage<T> { scope: string; items: T[]; nextCursor: string | null }
