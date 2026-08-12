import { createHash } from "node:crypto";

export type CustomerPortalQueryRateLimitDecision =
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; retryAfterSeconds: number }>;

export type CustomerPortalQueryRateLimiter = Readonly<{
  check(sessionId: string, ip: string): CustomerPortalQueryRateLimitDecision;
}>;

type Bucket = Readonly<{ startedAtMs: number; count: number }>;

function keyFor(sessionId: string, ip: string): string {
  return createHash("sha256")
    .update("laundry.customer-portal-query-rate.v1\0", "utf8")
    .update(sessionId, "utf8")
    .update("\0", "utf8")
    .update(ip, "utf8")
    .digest("base64url");
}

export function createCustomerPortalQueryRateLimiter(
  options: Readonly<{
    maxQueries?: number;
    windowMs?: number;
    maxBuckets?: number;
    nowMs?: () => number;
  }> = {},
): CustomerPortalQueryRateLimiter {
  const maxQueries = options.maxQueries ?? 60;
  const windowMs = options.windowMs ?? 60_000;
  const maxBuckets = options.maxBuckets ?? 20_000;
  const nowMs = options.nowMs ?? Date.now;
  if (
    !Number.isSafeInteger(maxQueries) ||
    maxQueries < 1 ||
    maxQueries > 10_000 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1_000 ||
    windowMs > 3_600_000 ||
    !Number.isSafeInteger(maxBuckets) ||
    maxBuckets < 1 ||
    maxBuckets > 100_000
  ) {
    throw new TypeError("Invalid customer portal query rate-limit configuration");
  }
  let buckets: ReadonlyMap<string, Bucket> = new Map();
  return Object.freeze({
    check(sessionId, ip) {
      const now = nowMs();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new TypeError("Invalid customer portal query rate-limit clock");
      }
      const active = new Map(
        [...buckets].filter(([, bucket]) => now - bucket.startedAtMs < windowMs),
      );
      const key = keyFor(sessionId, ip);
      const current = active.get(key);
      if (current !== undefined && current.count >= maxQueries) {
        buckets = active;
        return Object.freeze({
          allowed: false as const,
          retryAfterSeconds: Math.max(1, Math.ceil((current.startedAtMs + windowMs - now) / 1_000)),
        });
      }
      if (current === undefined && active.size >= maxBuckets) {
        buckets = active;
        return Object.freeze({ allowed: false as const, retryAfterSeconds: 1 });
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
      return Object.freeze({ allowed: true as const });
    },
  });
}
