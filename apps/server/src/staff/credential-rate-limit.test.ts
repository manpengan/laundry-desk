import assert from "node:assert/strict";
import test from "node:test";

import { createStaffCredentialRateLimiter } from "./credential-rate-limit.js";

test("credential completion limiter is session-scoped and resets after its window", () => {
  let now = 1_000;
  const limiter = createStaffCredentialRateLimiter({
    nowEpochSeconds: () => now,
    windowSeconds: 30,
    maxAttempts: 2,
  });

  assert.deepEqual(limiter.consume("session-a"), { allowed: true });
  assert.deepEqual(limiter.consume("session-a"), { allowed: true });
  assert.deepEqual(limiter.consume("session-a"), {
    allowed: false,
    retryAfterSeconds: 30,
  });
  assert.deepEqual(limiter.consume("session-b"), { allowed: true });

  now += 30;
  assert.deepEqual(limiter.consume("session-a"), { allowed: true });
});

test("credential completion limiter fails closed when its bounded session map is full", () => {
  const limiter = createStaffCredentialRateLimiter({
    nowEpochSeconds: () => 1_000,
    maxSessions: 1,
  });

  assert.deepEqual(limiter.consume("session-a"), { allowed: true });
  assert.deepEqual(limiter.consume("session-b"), {
    allowed: false,
    retryAfterSeconds: 60,
  });
});
