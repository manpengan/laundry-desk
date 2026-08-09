const DEFAULT_WINDOW_SECONDS = 60;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_SESSIONS = 10_000;

type Bucket = Readonly<{ count: number; windowStartedAt: number }>;

export type StaffCredentialRateLimitDecision =
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; retryAfterSeconds: number }>;

export type StaffCredentialRateLimiter = Readonly<{
  consume: (sessionId: string) => StaffCredentialRateLimitDecision;
}>;

export type StaffCredentialRateLimiterOptions = Readonly<{
  nowEpochSeconds?: () => number;
  windowSeconds?: number;
  maxAttempts?: number;
  maxSessions?: number;
}>;

export function createStaffCredentialRateLimiter(
  options: StaffCredentialRateLimiterOptions = {},
): StaffCredentialRateLimiter {
  const nowEpochSeconds = options.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1_000));
  const windowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  if (
    !Number.isSafeInteger(windowSeconds) ||
    windowSeconds < 1 ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isSafeInteger(maxSessions) ||
    maxSessions < 1
  ) {
    throw new TypeError("Invalid staff credential rate-limit policy");
  }
  let buckets: ReadonlyMap<string, Bucket> = new Map();

  return Object.freeze({
    consume: (sessionId) => {
      const now = nowEpochSeconds();
      const active = new Map(
        [...buckets].filter(([, bucket]) => now - bucket.windowStartedAt < windowSeconds),
      );
      const current = active.get(sessionId);
      if (current !== undefined && current.count >= maxAttempts) {
        buckets = active;
        return Object.freeze({
          allowed: false as const,
          retryAfterSeconds: Math.max(1, current.windowStartedAt + windowSeconds - now),
        });
      }
      if (current === undefined && active.size >= maxSessions) {
        buckets = active;
        return Object.freeze({ allowed: false as const, retryAfterSeconds: windowSeconds });
      }
      active.set(
        sessionId,
        Object.freeze({
          count: (current?.count ?? 0) + 1,
          windowStartedAt: current?.windowStartedAt ?? now,
        }),
      );
      buckets = active;
      return Object.freeze({ allowed: true as const });
    },
  });
}
