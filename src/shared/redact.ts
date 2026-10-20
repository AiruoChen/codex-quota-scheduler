export function redact(value: string): string {
  return value.replace(/Bearer\s+[\w.+/=-]+/gi, "Bearer [redacted]").replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]");
}
