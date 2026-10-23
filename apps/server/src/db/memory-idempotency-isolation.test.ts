import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { MemoryIdempotencyStore } from "../bus/idempotency.js";
import { createM1CommandRegistry } from "../bus/registry.js";
import type { ActorContext, DomainEvent } from "../bus/types.js";
import { FakeSqlClient } from "./fake-client.js";
import { createMemoryTransactionMap } from "./memory-transaction-collections.js";
import { MemoryTransactionConflictError } from "./memory-unit-of-work.js";

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return Object.freeze({ promise, resolve });
}

class CommitBarrierClient extends FakeSqlClient {
  readonly reached = deferred();
  readonly resume = deferred();

  override async query<TRow = unknown>(sql: string, params?: readonly unknown[]) {
    const result = await super.query<TRow>(sql, params);
    if (sql === "COMMIT") {
      this.reached.resolve();
      await this.resume.promise;
    }
    return result;
  }
}

test("memory CAS conflict after simulated COMMIT leaves no successful receipt or event", async () => {
  const tenant = Object.freeze({
    orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  });
  const actor: ActorContext = { staffId: tenant.staffId, deviceId: null, via: "ui" };
  const state = createMemoryTransactionMap([["count", 0]]);
  const store = new MemoryIdempotencyStore();
  const registry = createM1CommandRegistry();
  const events: DomainEvent[] = [];
  const errors: unknown[] = [];
  let handlerRuns = 0;
  registry.registerHandler("identity.logout", async () => {
    handlerRuns += 1;
    const count = state.get("count")! + 1;
    state.set("count", count);
    return {
      result: { count },
      audit: { entity: "synthetic", entityId: "memory-cas" },
      events: [{ type: "synthetic.committed", payload: { count } }],
    };
  });
  const options = (idempotencyKey: string) => ({
    actor,
    registry,
    idempotencyKey,
    idempotencyStore: store,
    eventBus: {
      publish: async (batch: readonly DomainEvent[]) => {
        events.push(...batch);
      },
    },
    onUnexpectedError: (error: unknown) => {
      errors.push(error);
    },
  });
  const firstKey = "11111111-1111-4111-8111-111111111111";
  const secondKey = "22222222-2222-4222-8222-222222222222";
  const barrier = new CommitBarrierClient();
  const firstWork = executeCommand(barrier, tenant, "identity.logout", {}, options(firstKey));
  await barrier.reached.promise;
  try {
    assert.equal(state.get("count"), 0);
    assert.equal(await store.get(tenant, "identity.logout", firstKey), null);
    const second = await executeCommand(
      new FakeSqlClient(),
      tenant,
      "identity.logout",
      {},
      options(secondKey),
    );
    assert.equal(second.ok, true);
  } finally {
    barrier.resume.resolve();
  }
  const failed = await firstWork;
  assert.equal(failed.ok, false);
  if (failed.ok) throw new Error("CAS conflict must reject the first command");
  assert.equal(failed.error.code, "TRANSACTION_FAILED");
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof MemoryTransactionConflictError);
  assert.equal(state.get("count"), 1);
  assert.equal(await store.get(tenant, "identity.logout", firstKey), null);
  assert.equal(store.size(), 1);
  assert.deepEqual(events, [{ type: "synthetic.committed", payload: { count: 1 } }]);
  // This is only a SQL call trace: FakeSqlClient never persists audit rows.
  assert.ok(barrier.sqlSequence().some((sql) => sql.includes("INSERT INTO audit_log")));
  assert.ok(barrier.sqlSequence().includes("COMMIT"));
  assert.equal(barrier.sqlSequence().at(-1), "ROLLBACK");

  const retry = () =>
    executeCommand(new FakeSqlClient(), tenant, "identity.logout", {}, options(firstKey));
  const retried = await retry();
  assert.equal(retried.ok, true);
  assert.equal(state.get("count"), 2);
  assert.equal(handlerRuns, 3);
  assert.equal(events.length, 2);
  assert.equal(store.size(), 2);
  assert.deepEqual(await store.get(tenant, "identity.logout", firstKey), retried);
  assert.deepEqual(await retry(), retried);
  assert.equal(handlerRuns, 3);
  assert.equal(state.get("count"), 2);
  assert.equal(events.length, 2);
});
