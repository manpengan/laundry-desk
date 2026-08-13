export type ByokMutationRateLimitDecision =
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; retryAfterSeconds: number }>;

export type ByokMutationRateLimiter = Readonly<{
  consume(sessionId: string): ByokMutationRateLimitDecision;
}>;

type Bucket = Readonly<{ count: number; startedAt: number }>;

export function createByokMutationRateLimiter(
  options: {
    readonly nowEpochSeconds?: () => number;
    readonly maxAttempts?: number;
    readonly windowSeconds?: number;
    readonly maxSessions?: number;
  } = {},
): ByokMutationRateLimiter {
  const nowEpochSeconds = options.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1_000));
  const maxAttempts = options.maxAttempts ?? 10;
  const windowSeconds = options.windowSeconds ?? 60;
  const maxSessions = options.maxSessions ?? 10_000;
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isSafeInteger(windowSeconds) ||
    windowSeconds < 1 ||
    !Number.isSafeInteger(maxSessions) ||
    maxSessions < 1
  ) {
    throw new TypeError("Invalid BYOK mutation rate-limit policy");
  }
  let buckets: ReadonlyMap<string, Bucket> = new Map();
  return Object.freeze({
    consume(sessionId) {
      const now = nowEpochSeconds();
      const active = new Map(
        [...buckets].filter(([, bucket]) => now - bucket.startedAt < windowSeconds),
      );
      const current = active.get(sessionId);
      if (current !== undefined && current.count >= maxAttempts) {
        buckets = active;
        return Object.freeze({
          allowed: false as const,
          retryAfterSeconds: Math.max(1, current.startedAt + windowSeconds - now),
        });
      }
      if (current === undefined && active.size >= maxSessions) {
        buckets = active;
        return Object.freeze({ allowed: false as const, retryAfterSeconds: windowSeconds });
      }
      active.set(
        sessionId,
        Object.freeze({ count: (current?.count ?? 0) + 1, startedAt: current?.startedAt ?? now }),
      );
      buckets = active;
      return Object.freeze({ allowed: true as const });
    },
  });
}
