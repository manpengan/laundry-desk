export type AiRateLimitDecision = Readonly<{
  allowed: boolean;
  retryAfterSeconds: number;
}>;

export type AiRateLimitInput = Readonly<{
  orgId: string;
  authSessionId: string;
}>;

export type AiRateLimiter = Readonly<{
  consume(input: AiRateLimitInput): AiRateLimitDecision;
}>;

type Bucket = Readonly<{ count: number; windowStartedAtMs: number }>;

export function createAiRateLimiter(
  options: Readonly<{
    now?: () => number;
    windowMs?: number;
    perSession?: number;
    perOrg?: number;
  }> = {},
): AiRateLimiter {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? 60_000;
  const perSession = options.perSession ?? 12;
  const perOrg = options.perOrg ?? 120;
  let buckets = new Map<string, Bucket>();

  const consumeBucket = (key: string, limit: number, at: number): AiRateLimitDecision => {
    const current = buckets.get(key);
    const bucket =
      current === undefined || at - current.windowStartedAtMs >= windowMs
        ? Object.freeze({ count: 0, windowStartedAtMs: at })
        : current;
    if (bucket.count >= limit) {
      return Object.freeze({
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((windowMs - (at - bucket.windowStartedAtMs)) / 1000),
        ),
      });
    }
    buckets = new Map(buckets).set(
      key,
      Object.freeze({ count: bucket.count + 1, windowStartedAtMs: bucket.windowStartedAtMs }),
    );
    return Object.freeze({ allowed: true, retryAfterSeconds: 0 });
  };

  return Object.freeze({
    consume(input) {
      const at = now();
      const org = consumeBucket(`org:${input.orgId}`, perOrg, at);
      if (!org.allowed) return org;
      return consumeBucket(`session:${input.authSessionId}`, perSession, at);
    },
  });
}
