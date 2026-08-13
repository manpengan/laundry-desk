import assert from "node:assert/strict";
import test from "node:test";

import { createAiRateLimiter } from "./streaming-rate-limit.js";

test("AI limiter enforces per-session and org windows without client-controlled dimensions", () => {
  let now = 1_000;
  const limiter = createAiRateLimiter({
    now: () => now,
    windowMs: 10_000,
    perSession: 2,
    perOrg: 3,
  });
  const first = { orgId: "org", authSessionId: "session-a" };
  assert.equal(limiter.consume(first).allowed, true);
  assert.equal(limiter.consume(first).allowed, true);
  const sessionBlocked = limiter.consume(first);
  assert.equal(sessionBlocked.allowed, false);
  assert.equal(sessionBlocked.retryAfterSeconds, 10);
  assert.equal(limiter.consume({ orgId: "org", authSessionId: "session-b" }).allowed, false);
  now += 10_000;
  assert.equal(limiter.consume(first).allowed, true);
});
