import { createHash } from "node:crypto";

export type FactoryOperationKind = "command" | "query";

export type FactoryOperationRateLimitDecision =
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; retryAfterSeconds: number }>;

export type FactoryOperationRateLimiter = Readonly<{
  check(
    kind: FactoryOperationKind,
    sessionId: string,
    orgId: string,
    storeId: string,
  ): FactoryOperationRateLimitDecision;
}>;

export type FactoryOperationRateLimiterOptions = Readonly<{
  maxCommands?: number;
  maxQueries?: number;
  windowMs?: number;
  maxBuckets?: number;
  nowMs?: () => number;
}>;

type Bucket = Readonly<{ startedAtMs: number; count: number }>;

const ALLOWED = Object.freeze({ allowed: true as const });
const DEFAULT_MAX_COMMANDS = 30;
const DEFAULT_MAX_QUERIES = 120;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_BUCKETS = 20_000;

function dimension(
  kind: FactoryOperationKind,
  sessionId: string,
  orgId: string,
  storeId: string,
): string {
  return createHash("sha256")
    .update("laundry.factory-operation-rate.v1\0", "utf8")
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(sessionId, "utf8")
    .update("\0", "utf8")
    .update(orgId, "utf8")
    .update("\0", "utf8")
    .update(storeId, "utf8")
    .digest("base64url");
}

function retryAfterSeconds(startedAtMs: number, windowMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((startedAtMs + windowMs - nowMs) / 1_000));
}

function activeBuckets(
  buckets: ReadonlyMap<string, Bucket>,
  nowMs: number,
  windowMs: number,
): ReadonlyMap<string, Bucket> {
  return new Map([...buckets].filter(([, bucket]) => nowMs - bucket.startedAtMs < windowMs));
}

function earliestStart(buckets: ReadonlyMap<string, Bucket>): number {
  let earliest = Number.MAX_SAFE_INTEGER;
  for (const bucket of buckets.values()) earliest = Math.min(earliest, bucket.startedAtMs);
  return earliest;
}

function validLimit(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

export function createFactoryOperationRateLimiter(
  options: FactoryOperationRateLimiterOptions = {},
): FactoryOperationRateLimiter {
  const maxCommands = options.maxCommands ?? DEFAULT_MAX_COMMANDS;
  const maxQueries = options.maxQueries ?? DEFAULT_MAX_QUERIES;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  const nowMs = options.nowMs ?? Date.now;
  if (
    !validLimit(maxCommands, 10_000) ||
    !validLimit(maxQueries, 10_000) ||
    !validLimit(windowMs, 3_600_000) ||
    windowMs < 1_000 ||
    !validLimit(maxBuckets, 100_000)
  ) {
    throw new TypeError("Invalid factory operation rate-limit configuration");
  }

  let buckets: ReadonlyMap<string, Bucket> = new Map();
  return Object.freeze({
    check: (kind, sessionId, orgId, storeId) => {
      const key = dimension(kind, sessionId, orgId, storeId);
      const now = nowMs();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new TypeError("Invalid factory operation rate-limit clock");
      }
      const active = activeBuckets(buckets, now, windowMs);
      const current = active.get(key);
      const limit = kind === "command" ? maxCommands : maxQueries;
      if (current !== undefined && current.count >= limit) {
        buckets = active;
        return Object.freeze({
          allowed: false as const,
          retryAfterSeconds: retryAfterSeconds(current.startedAtMs, windowMs, now),
        });
      }
      if (current === undefined && active.size >= maxBuckets) {
        buckets = active;
        return Object.freeze({
          allowed: false as const,
          retryAfterSeconds: retryAfterSeconds(earliestStart(active), windowMs, now),
        });
      }
      const next = new Map(active);
      next.set(
        key,
        Object.freeze({
          startedAtMs: current?.startedAtMs ?? now,
          count: (current?.count ?? 0) + 1,
        }),
      );
      buckets = next;
      return ALLOWED;
    },
  });
}
