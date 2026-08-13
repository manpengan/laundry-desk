import assert from "node:assert/strict";
import test from "node:test";

import { createCustomerPortalLoginTimingGuard } from "./login-timing.js";

test("customer login success and failure paths share one minimum response boundary", async () => {
  let nowMs = 10_000;
  const waits: number[] = [];
  const guard = createCustomerPortalLoginTimingGuard({
    minimumResponseMs: 500,
    nowMs: () => nowMs,
    waitMs: async (milliseconds) => {
      waits.push(milliseconds);
      nowMs += milliseconds;
    },
  });

  const missingCustomer = guard.start();
  nowMs += 8;
  await guard.settle(missingCustomer);
  assert.equal(nowMs - missingCustomer, 500);

  const existingCustomer = guard.start();
  nowMs += 37;
  await guard.settle(existingCustomer);
  assert.equal(nowMs - existingCustomer, 500);
  assert.deepEqual(waits, [492, 463]);
});

test("customer login timing policy rejects unsafe bounds and clock values", () => {
  assert.throws(
    () => createCustomerPortalLoginTimingGuard({ minimumResponseMs: 0 }),
    /timing policy/u,
  );
  const guard = createCustomerPortalLoginTimingGuard({ nowMs: () => Number.NaN });
  assert.throws(() => guard.start(), /timing clock/u);
});
