import assert from "node:assert/strict";
import test from "node:test";

import { createCommandError, M1_FIRST_WAVE_COMMAND_NAMES } from "@laundry/contracts";

import { createM1CommandRegistry } from "../bus/registry.js";
import { executeCommand } from "../bus/executor.js";
import { MemoryIdempotencyStore } from "../bus/idempotency.js";
import type { ActorContext, CommandHandler, DomainEvent } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { INSERT_AUDIT_LOG_SQL } from "../audit/write-audit.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});

const ACTOR: ActorContext = Object.freeze({
  staffId: TENANT.staffId,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  via: "ui" as const,
});

const FIXED_NOW = () => new Date("2026-07-21T12:00:00.000Z");
const FIXED_ID = () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const logoutHandler: CommandHandler = async () =>
  Object.freeze({
    result: Object.freeze({ logged_out: true }),
    audit: Object.freeze({ entity: "session", entityId: "s1" }),
    events: Object.freeze([{ type: "identity.session_revoked", payload: {} }]),
  });

function setupRegistry(handler: CommandHandler = logoutHandler) {
  const registry = createM1CommandRegistry();
  registry.registerHandler("identity.logout", handler);
  return registry;
}

test("registry loads M1 first-wave command names", () => {
  const registry = createM1CommandRegistry();
  const names = registry.names();
  assert.ok(names.includes("identity.logout"));
  assert.ok(names.includes("identity.login"));
  assert.ok(names.includes("platform.settings.set"));
  for (const name of M1_FIRST_WAVE_COMMAND_NAMES) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
});

test("unknown command returns RESOURCE_UNAVAILABLE without BEGIN", async () => {
  const client = new FakeSqlClient();
  const registry = createM1CommandRegistry();
  const result = await executeCommand(
    client,
    TENANT,
    "nope.command",
    {},
    {
      actor: ACTOR,
      registry,
    },
  );
  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.error.code, "RESOURCE_UNAVAILABLE");
  }
  assert.deepEqual(client.sqlSequence(), []);
});

test("successful execute runs chain, handler, audit INSERT, COMMIT", async () => {
  const client = new FakeSqlClient();
  const registry = setupRegistry();
  const result = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      now: FIXED_NOW,
      newId: FIXED_ID,
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.execution, "executed");
    assert.deepEqual(result.data.result, { logged_out: true });
  }
  const seq = client.sqlSequence();
  assert.equal(seq[0], "BEGIN");
  assert.equal(seq.at(-1), "COMMIT");
  assert.ok(seq.includes(INSERT_AUDIT_LOG_SQL));
});

test("chain fail-closed: rbac failure skips later steps and handler", async () => {
  const client = new FakeSqlClient();
  const calls: string[] = [];
  let handlerRan = false;
  const registry = setupRegistry(async () => {
    handlerRan = true;
    return { result: {} };
  });

  const result = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      chainHooks: {
        checkRbac: async () => {
          calls.push("rbac");
          return { ok: false, error: createCommandError("PERMISSION_DENIED") };
        },
        checkTenant: async () => {
          calls.push("tenant");
          return { ok: true, data: undefined };
        },
        checkPolicy: async () => {
          calls.push("policy");
          return { ok: true, data: { allowed: true as const } };
        },
        checkInvariants: async () => {
          calls.push("invariants");
          return { ok: true, data: { preview: true as const } };
        },
      },
    },
  );

  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.error.code, "PERMISSION_DENIED");
  }
  assert.deepEqual(calls, ["rbac"]);
  assert.equal(handlerRan, false);
  assert.equal(client.sqlSequence().includes(INSERT_AUDIT_LOG_SQL), false);
});

test("chain order: all five steps run on success path", async () => {
  const client = new FakeSqlClient();
  const calls: string[] = [];
  const registry = setupRegistry();
  await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      chainHooks: {
        checkRbac: async () => {
          calls.push("rbac");
          return { ok: true, data: undefined };
        },
        checkTenant: async () => {
          calls.push("tenant");
          return { ok: true, data: undefined };
        },
        checkPolicy: async () => {
          calls.push("policy");
          return { ok: true, data: { allowed: true as const } };
        },
        checkInvariants: async () => {
          calls.push("invariants");
          return { ok: true, data: { preview: true as const } };
        },
      },
    },
  );
  assert.deepEqual(calls, ["rbac", "tenant", "policy", "invariants"]);
});

test("validation failure on bad input (login missing password)", async () => {
  const client = new FakeSqlClient();
  const registry = createM1CommandRegistry();
  const result = await executeCommand(
    client,
    TENANT,
    "identity.login",
    { org_id: TENANT.orgId, store_id: TENANT.storeId, username: "x" },
    { actor: ACTOR, registry },
  );
  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.error.code, "VALIDATION_FAILED");
  }
});

test("dry_run returns preview and skips handler mutation + audit", async () => {
  const client = new FakeSqlClient();
  let handlerRan = false;
  const registry = setupRegistry(async () => {
    handlerRan = true;
    return { result: { should_not: true } };
  });

  const result = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      dryRun: true,
    },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.execution, "preview");
  }
  assert.equal(handlerRan, false);
  assert.equal(client.sqlSequence().includes(INSERT_AUDIT_LOG_SQL), false);
  assert.equal(client.sqlSequence().at(-1), "COMMIT");
});

test("idempotent replay returns cached result without re-exec", async () => {
  const client = new FakeSqlClient();
  let runs = 0;
  const registry = setupRegistry(async () => {
    runs += 1;
    return { result: { n: runs } };
  });
  const store = new MemoryIdempotencyStore();
  const key = "ffffffff-ffff-4fff-8fff-ffffffffffff";

  const first = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      idempotencyKey: key,
      idempotencyStore: store,
      now: FIXED_NOW,
      newId: FIXED_ID,
    },
  );
  const second = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      idempotencyKey: key,
      idempotencyStore: store,
    },
  );

  assert.equal(runs, 1);
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  // Second call must not open a new transaction.
  const begins = client.sqlSequence().filter((s) => s === "BEGIN");
  assert.equal(begins.length, 1);
});

test("domain events publish only after successful commit", async () => {
  const client = new FakeSqlClient();
  const published: DomainEvent[][] = [];
  const registry = setupRegistry();
  await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      now: FIXED_NOW,
      newId: FIXED_ID,
      eventBus: {
        publish: (events) => {
          published.push([...events]);
        },
      },
    },
  );
  assert.equal(published.length, 1);
  assert.equal(published[0]?.[0]?.type, "identity.session_revoked");
  assert.equal(client.sqlSequence().at(-1), "COMMIT");
});

test("policy denial is fail-closed before handler", async () => {
  const client = new FakeSqlClient();
  let handlerRan = false;
  const registry = setupRegistry(async () => {
    handlerRan = true;
    return { result: {} };
  });
  const result = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      chainHooks: {
        checkPolicy: async () => ({
          ok: false,
          error: createCommandError("POLICY_DENIED"),
        }),
      },
    },
  );
  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.error.code, "POLICY_DENIED");
  }
  assert.equal(handlerRan, false);
});

test("missing handler after successful chain returns RESOURCE_UNAVAILABLE", async () => {
  const client = new FakeSqlClient();
  const registry = createM1CommandRegistry();
  // identity.logout registered as definition only — no handler
  const result = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
    },
  );
  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.error.code, "RESOURCE_UNAVAILABLE");
  }
  assert.equal(client.sqlSequence().includes("ROLLBACK"), true);
});
