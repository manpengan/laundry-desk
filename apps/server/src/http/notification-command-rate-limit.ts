import { createHash } from "node:crypto";

export type NotificationCommandRateLimitDecision =
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; retryAfterSeconds: number }>;

export type NotificationCommandRateLimiter = Readonly<{
  check(sessionId: string, orgId: string, storeId: string): NotificationCommandRateLimitDecision;
}>;

export type NotificationCommandRateLimiterOptions = Readonly<{
  maxRequests?: number;
  windowMs?: number;
  maxBuckets?: number;
  nowMs?: () => number;
}>;

type Bucket = Readonly<{ startedAtMs: number; count: number }>;

const ALLOWED = Object.freeze({ allowed: true as const });
const DEFAULT_MAX_REQUESTS = 30;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_BUCKETS = 10_000;

function dimension(sessionId: string, orgId: string, storeId: string): string {
  return createHash("sha256")
    .update("laundry.notification-command-rate.v1\0", "utf8")
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

export function createNotificationCommandRateLimiter(
  options: NotificationCommandRateLimiterOptions = {},
): NotificationCommandRateLimiter {
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  const nowMs = options.nowMs ?? Date.now;
  if (
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 1 ||
    maxRequests > 10_000 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1_000 ||
    windowMs > 3_600_000 ||
    !Number.isSafeInteger(maxBuckets) ||
    maxBuckets < 1 ||
    maxBuckets > 100_000
  ) {
    throw new TypeError("Invalid notification command rate-limit configuration");
  }

  let buckets: ReadonlyMap<string, Bucket> = new Map();
  return Object.freeze({
    check: (sessionId, orgId, storeId) => {
      const key = dimension(sessionId, orgId, storeId);
      const now = nowMs();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new TypeError("Invalid notification command rate-limit clock");
      }
      const active = activeBuckets(buckets, now, windowMs);
      const current = active.get(key);
      if (current !== undefined && current.count >= maxRequests) {
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
