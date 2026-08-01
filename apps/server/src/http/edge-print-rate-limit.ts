import { createHash } from "node:crypto";

export type EdgePrintRateLimitDecision =
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; retryAfterSeconds: number }>;

export type EdgePrintRateLimiter = Readonly<{
  check(sessionId: string, deviceId: string): EdgePrintRateLimitDecision;
}>;

export type EdgePrintRateLimiterOptions = Readonly<{
  maxRequests?: number;
  windowMs?: number;
  nowMs?: () => number;
}>;

type Bucket = Readonly<{ startedAtMs: number; count: number }>;

const ALLOWED = Object.freeze({ allowed: true as const });

function dimension(sessionId: string, deviceId: string): string {
  return createHash("sha256")
    .update("laundry.edge.print-rate.v1\0", "utf8")
    .update(sessionId, "utf8")
    .update("\0", "utf8")
    .update(deviceId, "utf8")
    .digest("base64url");
}

export function createEdgePrintRateLimiter(
  options: EdgePrintRateLimiterOptions = {},
): EdgePrintRateLimiter {
  const maxRequests = options.maxRequests ?? 120;
  const windowMs = options.windowMs ?? 60_000;
  const nowMs = options.nowMs ?? Date.now;
  if (
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 1 ||
    maxRequests > 10_000 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1_000 ||
    windowMs > 3_600_000
  ) {
    throw new TypeError("Invalid Edge print rate-limit configuration");
  }

  let buckets: ReadonlyMap<string, Bucket> = new Map();
  return Object.freeze({
    check: (sessionId, deviceId) => {
      const key = dimension(sessionId, deviceId);
      const now = nowMs();
      const current = buckets.get(key);
      const active = current !== undefined && now - current.startedAtMs < windowMs;
      if (active && current.count >= maxRequests) {
        return Object.freeze({
          allowed: false as const,
          retryAfterSeconds: Math.max(1, Math.ceil((current.startedAtMs + windowMs - now) / 1_000)),
        });
      }
      const next = new Map(
        [...buckets].filter(([, bucket]) => now - bucket.startedAtMs < windowMs),
      );
      next.set(
        key,
        Object.freeze({
          startedAtMs: active ? current.startedAtMs : now,
          count: active ? current.count + 1 : 1,
        }),
      );
      buckets = next;
      return ALLOWED;
    },
  });
}
