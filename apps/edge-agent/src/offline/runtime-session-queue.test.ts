import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DesktopSessionViewSchema, type EdgeQueueEnvelope } from "@laundry/contracts";
import {
  AUTHORITY_NONCE,
  IDEMPOTENCY_ID,
  authorityData,
  createRuntime,
  perGrantSequence,
  receiveInput,
  session,
} from "./runtime-test-fixtures.js";
import { offlineResourceFailure } from "./offline-results.js";

test("a session change during queue input validation cannot reserve or enqueue under the new session", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-queue-session-"));
  try {
    const replayed: EdgeQueueEnvelope[] = [];
    const { queue, runtime } = createRuntime(root, async (envelope) => {
      replayed.push(envelope);
      return { ok: true, data: { execution: "executed", result: {} } };
    });
    assert.equal(runtime.provision(authorityData(), session, AUTHORITY_NONCE), true);
    let current = true;
    const options = { idempotencyKey: IDEMPOTENCY_ID, isSessionCurrent: () => current };
    const pending = runtime.queueCommand(receiveInput(), options);
    current = false;
    runtime.reconcileSession(
      DesktopSessionViewSchema.parse({
        ...session,
        session: { ...session.session, session_id: "10000000-0000-4000-8000-000000000006" },
      }),
    );
    assert.deepEqual(await pending, offlineResourceFailure());
    assert.equal(queue.status().pendingCount, 0);
    assert.equal(queue.status().inflightCount, 0);

    const acceptedOptions = { idempotencyKey: IDEMPOTENCY_ID, isSessionCurrent: () => true };
    assert.equal((await runtime.queueCommand(receiveInput(), acceptedOptions)).ok, true);
    assert.equal(queue.status().pendingCount, 1);
    await runtime.replay();
    assert.equal(replayed.length, 1);
    assert.equal(
      perGrantSequence(replayed[0]!),
      1,
      "rejected stale intent must not consume a grant sequence",
    );
    assert.equal(replayed[0]?.payload.idempotency_key, IDEMPOTENCY_ID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
