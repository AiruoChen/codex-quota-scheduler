import { AppError } from "./errors.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AppError("INVALID_INPUT", `${label} 必须是对象`);
  return value;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError("INVALID_INPUT", `${label} 必须是非空字符串`);
  }
  return value;
}

export function requireNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new AppError("INVALID_INPUT", `${label} 必须在 ${min} 到 ${max} 之间`);
  }
  return value;
}
