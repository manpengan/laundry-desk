import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryLocalRuntime } from "../local/demo-seed.js";
import type { PendingActionStore } from "../pending-actions/types.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";

test("startup prefers runtime-wide pending cleanup over the local-profile fallback", async () => {
  const runtime = await createMemoryLocalRuntime();
  let globalCalls = 0;
  let scopedCalls = 0;
  const pendingStore: PendingActionStore = Object.freeze({
    lockPrivacy: () => undefined,
    measureRiskReservation: () => {
      throw new Error("not used");
    },
    findByIdempotency: () => null,
    create: () => {
      throw new Error("not used by cleanup test");
    },
    get: () => null,
    atomicConsume: () => Object.freeze({ ok: false as const, reason: "NOT_FOUND" as const }),
    pruneExpired: () => {
      scopedCalls += 1;
      return 0;
    },
    pruneExpiredGlobally: () => {
      globalCalls += 1;
      return 0;
    },
  });
  const app = await createLocalApp({
    runtime: Object.freeze({ ...runtime, pendingStore }),
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
  });

  await app.ready();
  assert.equal(globalCalls, 1);
  assert.equal(scopedCalls, 0);
  await app.close();
});
