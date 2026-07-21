/**
 * Stable JSON canonicalization for pending-action args_hash (WYSIWYS).
 * Object keys sorted lexicographically; safe integers only; acyclic plain data.
 */

import { createHash } from "node:crypto";

import type { CanonicalJson } from "./types.js";

const isPlainRecord = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const compareKeys = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const serializeNumber = (value: number): string => {
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
    throw new TypeError("Canonical numbers must be non-negative-zero safe integers");
  }
  return String(value);
};

const serializeArray = (value: readonly unknown[], ancestors: WeakSet<object>): string => {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
    throw new TypeError("Canonical arrays must be dense and contain no extra properties");
  }
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("Canonical arrays must be dense data properties");
    }
    parts.push(serializeValue(descriptor.value, ancestors));
  }
  return `[${parts.join(",")}]`;
};

const serializeRecord = (value: object, ancestors: WeakSet<object>): string => {
  const entries = Reflect.ownKeys(value)
    .map((key): readonly [string, unknown] => {
      if (typeof key !== "string") {
        throw new TypeError("Canonical records may not have symbol keys");
      }
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new TypeError("Canonical records may not contain prototype-related keys");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("Canonical records may not have accessors");
      }
      return [key, descriptor.value];
    })
    .sort(([left], [right]) => compareKeys(left, right));

  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${serializeValue(entry, ancestors)}`)
    .join(",")}}`;
};

const serializeValue = (value: unknown, ancestors: WeakSet<object>): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return serializeNumber(value);
  if (typeof value !== "object") {
    throw new TypeError("Canonical values must be JSON-compatible");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Canonical values must be acyclic");
  }
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    throw new TypeError("Canonical objects must be plain records");
  }
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? serializeArray(value, ancestors)
      : serializeRecord(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
};

/** Deterministic JSON string with sorted object keys. */
export function canonicalize(value: unknown): string {
  return serializeValue(value, new WeakSet());
}

/** SHA-256 hex digest of the canonical serialization. */
export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

/**
 * Deep-freeze a JSON-compatible value tree into CanonicalJson.
 * Rejects non-JSON types the same way as canonicalize.
 */
export function freezeCanonical(value: unknown): CanonicalJson {
  // Round-trip through canonical string + JSON.parse for a plain, detached tree.
  const parsed: unknown = JSON.parse(canonicalize(value));
  return deepFreezeJson(parsed);
}

const deepFreezeJson = (value: unknown): CanonicalJson => {
  if (value === null || typeof value !== "object") {
    return value as CanonicalJson;
  }
  if (Array.isArray(value)) {
    const next = value.map((entry) => deepFreezeJson(entry));
    return Object.freeze(next);
  }
  const record = value as Record<string, unknown>;
  const next: Record<string, CanonicalJson> = {};
  for (const key of Object.keys(record).sort(compareKeys)) {
    next[key] = deepFreezeJson(record[key]);
  }
  return Object.freeze(next);
};
