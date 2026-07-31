import assert from "node:assert/strict";
import test from "node:test";

import { createCommandError } from "@laundry/contracts";

import { executeCommand } from "../bus/executor.js";
import { createM1CommandRegistry } from "../bus/registry.js";
import type { ActorContext, CommandTransactionGuard } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});
const ACTOR: ActorContext = Object.freeze({
  staffId: TENANT.staffId,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  via: "edge_replay",
});
const ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function registryWithMutation() {
  const registry = createM1CommandRegistry();
  registry.registerHandler("identity.logout", async ({ client }) => {
    await client.query("INSERT INTO replay_domain_probe DEFAULT VALUES");
    return Object.freeze({ result: Object.freeze({ logged_out: true }) });
  });
  return registry;
}

test("transaction guard settles after domain mutation and audit before one commit", async () => {
  const client = new FakeSqlClient();
  const state = Object.freeze({ claim: ID });
  const guard: CommandTransactionGuard = Object.freeze({
    before: async (tx) => {
      await tx.query("SELECT replay_claim FOR UPDATE");
      return Object.freeze({ kind: "continue" as const, state });
    },
    settle: async (tx, _context, received, result) => {
      assert.equal(received, state);
      assert.equal(result.ok, true);
      await tx.query("INSERT INTO replay_record DEFAULT VALUES");
    },
  });

  const result = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry: registryWithMutation(),
      transactionGuard: guard,
      now: () => new Date("2026-07-30T01:02:03.000Z"),
      newId: () => ID,
    },
  );
  assert.equal(result.ok, true);
  const statements = client.sqlSequence();
  assert.ok(
    statements.indexOf("SELECT replay_claim FOR UPDATE") <
      statements.indexOf("INSERT INTO replay_domain_probe DEFAULT VALUES"),
  );
  assert.ok(
    statements.indexOf("INSERT INTO replay_domain_probe DEFAULT VALUES") <
      statements.indexOf("INSERT INTO replay_record DEFAULT VALUES"),
  );
  assert.equal(statements.at(-1), "COMMIT");
});

test("guard short-circuit records arbitration without invoking the handler", async () => {
  const client = new FakeSqlClient();
  let handlerCalled = false;
  const registry = createM1CommandRegistry();
  registry.registerHandler("identity.logout", async () => {
    handlerCalled = true;
    return Object.freeze({ result: Object.freeze({ logged_out: true }) });
  });
  const guard: CommandTransactionGuard = Object.freeze({
    before: async (tx) => {
      await tx.query("INSERT INTO replay_arbitration DEFAULT VALUES");
      return Object.freeze({
        kind: "return" as const,
        result: Object.freeze({
          ok: false as const,
          error: createCommandError("REPLAY_ARBITRATION_REQUIRED"),
        }),
      });
    },
    settle: async () => {
      throw new Error("short-circuit must not settle");
    },
  });

  const result = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      transactionGuard: guard,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error.code, "REPLAY_ARBITRATION_REQUIRED");
  assert.equal(handlerCalled, false);
  assert.equal(client.sqlSequence().at(-1), "COMMIT");
});

test("settle failure rolls back the domain mutation and hides internal details", async () => {
  const client = new FakeSqlClient();
  const guard: CommandTransactionGuard = Object.freeze({
    before: async () => Object.freeze({ kind: "continue" as const, state: Object.freeze({}) }),
    settle: async () => {
      throw new Error("private replay persistence failure");
    },
  });
  const result = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry: registryWithMutation(),
      transactionGuard: guard,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error.code, "TRANSACTION_FAILED");
  assert.equal(client.sqlSequence().at(-1), "ROLLBACK");
});
