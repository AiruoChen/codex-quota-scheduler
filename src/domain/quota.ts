export interface QuotaWindow {
  slot: "primary" | "secondary";
  durationMinutes: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
}

export interface QuotaBucket {
  id: string;
  name: string | null;
  planType: string | null;
  reachedType: string | null;
  windows: QuotaWindow[];
}

export interface QuotaSnapshot {
  source: "mock" | "codex";
  fetchedAt: string;
  buckets: QuotaBucket[];
}

export interface QuotaProvider {
  read(): Promise<QuotaSnapshot>;
}
