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
  account?: {
    type: "chatgpt";
    email: string | null;
    planType: string | null;
    workspaceId: string | null;
  };
  cli?: { version: string };
}

export interface QuotaProvider {
  read(signal?: AbortSignal): Promise<QuotaSnapshot>;
}

/** Notifications invalidate cached data; their partial payloads are never authoritative. */
export interface QuotaFeed extends QuotaProvider {
  subscribe(listener: () => void): () => void;
  close(): Promise<void>;
}
