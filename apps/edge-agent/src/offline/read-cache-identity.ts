import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`)
    .join(",")}}`;
}

/** Stable cache key for a query input: canonical JSON and its SHA-256. */
export function queryIdentity(input: unknown): Readonly<{ canonical: string; key: string }> {
  const canonical = canonicalJson(input);
  return Object.freeze({
    canonical,
    key: createHash("sha256").update(canonical, "utf8").digest("hex"),
  });
}
