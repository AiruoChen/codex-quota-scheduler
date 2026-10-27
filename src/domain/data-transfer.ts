export interface DataInspection {
  schema: number; tasks: number; versions: number; runs: number; attention: number;
  fingerprint: string; seeded: boolean;
}
export interface ImportPreview extends DataInspection {
  token: string; source: string; sourceDatabase: string; target: string;
  provider: "mock" | "codex"; createdAt: string;
}
export interface DataProfile { id: string; config: string; active: boolean }
export interface DesktopDataView {
  busy: boolean; config: string; directory: string; version: string; schema: number;
  preview: ImportPreview | null; profiles: DataProfile[];
  backup: string | null; code: string | null;
}
