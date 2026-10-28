export class AppError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AppError";
  }
}

export function systemErrorCode(error: unknown): string {
  const codes = ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EBUSY", "EIO", "ENOSPC"];
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && codes.includes(code) ? code : "unknown";
}
