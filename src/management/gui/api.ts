let csrf = "";

export async function api<T>(path: string, data?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30000),
    ...(data ? { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(data) } : {}) });
  const result: unknown = await response.json();
  if (!response.ok) {
    const error = (result as { error?: { code?: string; message?: string } }).error;
    throw new Error(`${error?.message ?? "请求失败"} (${error?.code ?? response.status})`);
  }
  return result as T;
}

export async function bootstrap(): Promise<void> { csrf = (await api<{ csrf: string }>("/api/bootstrap")).csrf; }
