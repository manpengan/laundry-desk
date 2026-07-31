import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopOfflinePort } from "./offline-port.js";

const QUEUE_ID = "3a2eed00-a6c3-493c-a3a7-20bf94b1d678";
const STATUS = Object.freeze({
  ok: true,
  data: Object.freeze({
    pending_count: 1,
    inflight_count: 0,
    conflicts: Object.freeze([
      Object.freeze({
        queue_id: QUEUE_ID,
        command: "order.pickup",
        error_code: "INVARIANT_FAILED",
        created_at: "2026-07-30T12:00:00.000Z",
      }),
    ]),
  }),
});

test("desktop offline discard injects the fixed confirmation and bounded reason", async () => {
  const seen: unknown[] = [];
  const port = createDesktopOfflinePort(
    Object.freeze({
      status: async () => STATUS,
      resolve: async (input) => {
        seen.push(input);
        return STATUS;
      },
    }),
  );

  assert.equal((await port.resolve(QUEUE_ID, "discard", "  operator checked ledger  ")).ok, true);
  assert.deepEqual(seen, [
    {
      queue_id: QUEUE_ID,
      action: "discard",
      reason: "operator checked ledger",
      confirm: "DISCARD",
    },
  ]);
});

test("desktop offline discard fails before IPC without a reason", async () => {
  let invoked = false;
  const port = createDesktopOfflinePort(
    Object.freeze({
      status: async () => STATUS,
      resolve: async () => {
        invoked = true;
        return STATUS;
      },
    }),
  );

  assert.equal((await port.resolve(QUEUE_ID, "discard", " ")).ok, false);
  assert.equal(invoked, false);
});
