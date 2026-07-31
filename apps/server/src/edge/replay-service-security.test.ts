import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { EdgeReplayRequestSchema, type EdgeReplayRequest } from "@laundry/contracts";

import type { PgPool } from "../db/pg-pool.js";
import { createMemoryLocalRuntime } from "../local/demo-seed.js";
import { authoritySession } from "./authority-test-fixture.js";
import { createPgReplayGuard } from "./pg-replay-guard.js";
import type { PreparedPgReplay } from "./pg-replay.js";
import { executeEdgeReplay } from "./replay-service.js";

const DEVICE_ID = "31a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const GRANT_ID = "41a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const LEASE_ID = "51a2eed0-a6c3-493c-a3a7-20bf94b1d678";

function replayRequest(queueVersion: number): EdgeReplayRequest {
  return EdgeReplayRequestSchema.parse({
    protocol_version: "1.0.0",
    payload: {
      device_id: DEVICE_ID,
      envelope: {
        queue_envelope_version: queueVersion,
        contracts_major: 0,
        queue_id: randomUUID(),
        enqueued_at: "2026-07-31T01:02:03.000Z",
        payload: {
          command: "payment.collect",
          version: "0.2.0",
          mode: "direct",
          args: { order_id: randomUUID(), amount_cents: 100, method: "cash" },
          idempotency_key: randomUUID(),
          dry_run: false,
        },
        authorization: {
          kind: "primary_lease",
          grant_id: GRANT_ID,
          lease_id: LEASE_ID,
          primary_epoch: 1,
          per_lease_seq: 1,
        },
      },
    },
    sig: "A".repeat(86),
  });
}

async function pgShapedRuntime() {
  const runtime = await createMemoryLocalRuntime();
  return Object.freeze({
    ...runtime,
    mode: "pg" as const,
    pool: Object.freeze({}) as PgPool,
  });
}

test("older and future queue versions arbitrate before authority preparation", async () => {
  const runtime = await pgShapedRuntime();
  let prepareCalls = 0;
  const prepare = async (): Promise<null> => {
    prepareCalls += 1;
    return null;
  };
  for (const queueVersion of [1, 3]) {
    const result = await executeEdgeReplay(
      runtime,
      authoritySession("admin"),
      replayRequest(queueVersion),
      randomUUID,
      { prepare },
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.error.code, "REPLAY_ARBITRATION_REQUIRED");
  }
  assert.equal(prepareCalls, 0);
});

test("permanent authority rejection is a non-retryable arbitration result", async () => {
  const runtime = await pgShapedRuntime();
  let prepareCalls = 0;
  const result = await executeEdgeReplay(
    runtime,
    authoritySession("admin"),
    replayRequest(2),
    randomUUID,
    {
      prepare: async () => {
        prepareCalls += 1;
        return null;
      },
    },
  );
  assert.equal(prepareCalls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error.code, "REPLAY_ARBITRATION_REQUIRED");
});

test("guard construction refuses a compatibility-bypassed prepared replay", () => {
  const request = replayRequest(1);
  const prepared: PreparedPgReplay = Object.freeze({
    request,
    orgId: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    storeId: "11a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    originalStaffId: "21a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    replayedByStaffId: "22a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    deviceId: DEVICE_ID,
    permissionVersion: 1,
    role: "staff",
    isPrivacyAdmin: false,
    envelopeSha256: "a".repeat(64),
    publicKeySpki: "A".repeat(60),
  });
  assert.throws(() => createPgReplayGuard(prepared, randomUUID), /compatibility/u);
});
