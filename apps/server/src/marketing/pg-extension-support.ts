export function marketingInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe integer`);
  return parsed;
}

export function marketingTimestamp(value: Date | string, label: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

export function marketingDatabaseText(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  return `${String(Reflect.get(error, "message") ?? "")} ${String(
    Reflect.get(error, "constraint") ?? "",
  )}`;
}
