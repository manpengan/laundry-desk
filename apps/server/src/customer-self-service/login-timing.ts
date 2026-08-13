import { performance } from "node:perf_hooks";

const DEFAULT_MINIMUM_RESPONSE_MS = 500;

export type CustomerPortalLoginTimingGuard = Readonly<{
  start(): number;
  settle(startedAtMs: number): Promise<void>;
}>;

type LoginTimingOptions = Readonly<{
  minimumResponseMs?: number;
  nowMs?: () => number;
  waitMs?: (milliseconds: number) => Promise<void>;
}>;

const systemWait = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Pad credential checks so the no-customer branch is not a useful timing oracle. */
export function createCustomerPortalLoginTimingGuard(
  options: LoginTimingOptions = {},
): CustomerPortalLoginTimingGuard {
  const minimumResponseMs = options.minimumResponseMs ?? DEFAULT_MINIMUM_RESPONSE_MS;
  const nowMs = options.nowMs ?? (() => performance.now());
  const waitMs = options.waitMs ?? systemWait;
  if (
    !Number.isSafeInteger(minimumResponseMs) ||
    minimumResponseMs < 1 ||
    minimumResponseMs > 5_000
  ) {
    throw new TypeError("Invalid customer portal login timing policy");
  }
  return Object.freeze({
    start() {
      const now = nowMs();
      if (!Number.isFinite(now) || now < 0) {
        throw new TypeError("Invalid customer portal login timing clock");
      }
      return now;
    },
    async settle(startedAtMs) {
      const now = nowMs();
      const elapsed = Number.isFinite(now) && now >= startedAtMs ? now - startedAtMs : 0;
      const remaining = Math.max(0, minimumResponseMs - elapsed);
      if (remaining > 0) await waitMs(remaining);
    },
  });
}
