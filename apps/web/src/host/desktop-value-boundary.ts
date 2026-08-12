const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPERATION_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const MAX_OPERATION_NAME_LENGTH = 128;
const MAX_BUSINESS_VALUE_NODES = 10_000;
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "cookie",
  "cookies",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "token",
]);

export const EMPTY_BUSINESS_BODY: Readonly<Record<string, never>> = Object.freeze({});

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isOperationName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_OPERATION_NAME_LENGTH &&
    OPERATION_NAME.test(value)
  );
}

export function readCommandOptions(value: unknown): Readonly<{ confirmRef?: string }> | null {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length === 0) return Object.freeze({});
  if (keys.length !== 1 || keys[0] !== "confirmRef") return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, "confirmRef");
  if (descriptor === undefined || !("value" in descriptor) || !isUuid(descriptor.value)) {
    return null;
  }
  return Object.freeze({ confirmRef: descriptor.value });
}

function isCredentialBoundaryKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return FORBIDDEN_CREDENTIAL_KEYS.has(normalized) || normalized.endsWith("token");
}

/** Reject non-JSON values and credential-shaped keys before fixed host schemas run. */
export function isSafeBusinessValue(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    ) {
      continue;
    }
    if (typeof current !== "object" || seen.has(current)) return false;
    if (++visited > MAX_BUSINESS_VALUE_NODES) return false;
    seen.add(current);
    if (!Array.isArray(current)) {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return false;
    }
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string" || isCredentialBoundaryKey(key)) return false;
      if (Array.isArray(current) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !("value" in descriptor)) return false;
      pending.push(descriptor.value);
    }
  }
  return true;
}
