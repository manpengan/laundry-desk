import assert from "node:assert/strict";
import test from "node:test";

import { createCommandError, M1_FIRST_WAVE_COMMAND_NAMES } from "@laundry/contracts";

import { createM1CommandRegistry } from "../bus/registry.js";
import { executeCommand } from "../bus/executor.js";
import { MemoryIdempotencyStore } from "../bus/idempotency.js";
import type {
  ActorContext,
  CommandHandler,
  CommandResult,
  DomainEvent,
  DurableIdempotencyLookup,
  TransactionalIdempotencyStore,
} from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
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

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return Object.freeze({ promise, resolve });
}

class TestTransactionalIdempotencyStore implements TransactionalIdempotencyStore {
  private readonly rows = new Map<
    string,
    Readonly<{ hash: string; result: CommandResult | null }>
  >();

  async lookup(
    _tenant: TenantContext,
    command: string,
    key: string,
    requestHash: string,
  ): Promise<DurableIdempotencyLookup> {
    return this.read(command, key, requestHash);
  }

  async claim(
    _client: SqlClient,
    _tenant: TenantContext,
    command: string,
    key: string,
    requestHash: string,
  ): Promise<DurableIdempotencyLookup> {
    const current = this.read(command, key, requestHash);
    if (current.kind !== "miss") return current;
    this.rows.set(`${command}:${key}`, Object.freeze({ hash: requestHash, result: null }));
    return Object.freeze({ kind: "miss" });
  }

  async complete(
    _client: SqlClient,
    _tenant: TenantContext,
    command: string,
    key: string,
    requestHash: string,
    result: CommandResult,
  ): Promise<void> {
    this.rows.set(`${command}:${key}`, Object.freeze({ hash: requestHash, result }));
  }

  private read(command: string, key: string, requestHash: string): DurableIdempotencyLookup {
    const row = this.rows.get(`${command}:${key}`);
    if (row === undefined) return Object.freeze({ kind: "miss" });
    if (row.hash !== requestHash) return Object.freeze({ kind: "conflict" });
    return row.result === null
      ? Object.freeze({ kind: "in_progress" })
      : Object.freeze({ kind: "replay", result: row.result });
  }
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

test("unexpected command failures are privately observable without leaking details", async () => {
  const client = new FakeSqlClient();
  const sentinel = new Error("credential-bearing-database-detail");
  const observed: unknown[] = [];
  const registry = setupRegistry(async () => {
    throw sentinel;
  });

  const result = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      onUnexpectedError: (error) => observed.push(error),
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "TRANSACTION_FAILED");
  assert.deepEqual(observed, [sentinel]);
  assert.doesNotMatch(JSON.stringify(result), /credential-bearing-database-detail/iu);
  assert.equal(client.sqlSequence().at(-1), "ROLLBACK");
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
  const conflict = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      version: "1.0.1",
      idempotencyKey: key,
      idempotencyStore: store,
    },
  );

  assert.equal(runs, 1);
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");
  // Replays still cross the authorization chain inside a transaction.
  const begins = client.sqlSequence().filter((s) => s === "BEGIN");
  assert.equal(begins.length, 3);
});

test("memory idempotency permits only one concurrent execution per request", async () => {
  const started = deferred();
  const release = deferred();
  let runs = 0;
  const registry = setupRegistry(async () => {
    runs += 1;
    started.resolve();
    await release.promise;
    return { result: { n: runs } };
  });
  const store = new MemoryIdempotencyStore();
  const key = "fafafafa-fafa-4afa-8afa-fafafafafafa";
  const options = Object.freeze({
    actor: ACTOR,
    registry,
    idempotencyKey: key,
    idempotencyStore: store,
  });
  const firstWork = executeCommand(new FakeSqlClient(), TENANT, "identity.logout", {}, options);
  await started.promise;
  const concurrent = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "identity.logout",
    {},
    options,
  );
  assert.equal(concurrent.ok, false);
  if (!concurrent.ok) assert.equal(concurrent.error.code, "RESOURCE_UNAVAILABLE");
  release.resolve();
  assert.equal((await firstWork).ok, true);
  assert.equal(runs, 1);
});

test("memory idempotency does not expose completed replay before COMMIT", async () => {
  const commitReached = deferred();
  const releaseCommit = deferred();
  class CommitBarrierClient extends FakeSqlClient {
    override async query<TRow>(sql: string, params?: readonly unknown[]) {
      const result = await super.query<TRow>(sql, params);
      if (sql === "COMMIT") {
        commitReached.resolve();
        await releaseCommit.promise;
        throw new Error("injected commit failure");
      }
      return result;
    }
  }
  const store = new MemoryIdempotencyStore();
  const options = Object.freeze({
    actor: ACTOR,
    registry: setupRegistry(),
    idempotencyKey: "fdfdfdfd-fdfd-4dfd-8dfd-fdfdfdfdfdfd",
    idempotencyStore: store,
  });
  const firstWork = executeCommand(
    new CommitBarrierClient(),
    TENANT,
    "identity.logout",
    {},
    options,
  );
  await commitReached.promise;

  const concurrent = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "identity.logout",
    {},
    options,
  );
  assert.equal(concurrent.ok, false);
  if (!concurrent.ok) assert.equal(concurrent.error.code, "RESOURCE_UNAVAILABLE");

  releaseCommit.resolve();
  const failed = await firstWork;
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, "TRANSACTION_FAILED");
  assert.equal(store.size(), 0);
});

test("memory idempotency releases an uncommitted claim after handler failure", async () => {
  let runs = 0;
  const registry = setupRegistry(async () => {
    runs += 1;
    if (runs === 1) throw new Error("injected handler failure");
    return { result: { n: runs } };
  });
  const store = new MemoryIdempotencyStore();
  const options = Object.freeze({
    actor: ACTOR,
    registry,
    idempotencyKey: "fbfbfbfb-fbfb-4bfb-8bfb-fbfbfbfbfbfb",
    idempotencyStore: store,
  });
  const first = await executeCommand(new FakeSqlClient(), TENANT, "identity.logout", {}, options);
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.error.code, "TRANSACTION_FAILED");
  assert.equal(store.size(), 0);
  assert.equal(
    (await executeCommand(new FakeSqlClient(), TENANT, "identity.logout", {}, options)).ok,
    true,
  );
  assert.equal(runs, 2);
});

test("durable idempotency replays the committed result and rejects changed requests", async () => {
  const client = new FakeSqlClient();
  let runs = 0;
  const registry = setupRegistry(async () => {
    runs += 1;
    return { result: { n: runs } };
  });
  const key = "abababab-abab-4bab-8bab-abababababab";
  const store = new TestTransactionalIdempotencyStore();

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
  const replay = await executeCommand(
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
  const conflict = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      version: "1.0.1",
      idempotencyKey: key,
      idempotencyStore: store,
    },
  );

  assert.equal(runs, 1);
  assert.deepEqual(replay, first);
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(client.sqlSequence().filter((sql) => sql === "BEGIN").length, 3);
});

test("durable replay never bypasses the current actor authorization chain", async () => {
  const client = new FakeSqlClient();
  const registry = setupRegistry();
  const key = "acacacac-acac-4cac-8cac-acacacacacac";
  const store = new TestTransactionalIdempotencyStore();
  const allowed = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      idempotencyKey: key,
      idempotencyStore: store,
      chainHooks: { checkRbac: async () => ({ ok: true, data: undefined }) },
    },
  );
  assert.equal(allowed.ok, true);

  const denied = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      idempotencyKey: key,
      idempotencyStore: store,
      chainHooks: {
        checkRbac: async () => ({
          ok: false,
          error: createCommandError("PERMISSION_DENIED"),
        }),
      },
    },
  );
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "PERMISSION_DENIED");
  assert.doesNotMatch(JSON.stringify(denied), /logged_out/iu);
});

test("a persisted confirmation card cannot cross a registered command version change", async () => {
  const pendingStore = new MemoryPendingActionStore();
  const confirmRef = "adadadad-adad-4dad-8dad-adadadadadad";
  const createdAt = Math.floor(FIXED_NOW().getTime() / 1000);
  await pendingStore.create({
    nonce: confirmRef,
    command: "identity.logout",
    commandVersion: "0.9.0",
    args: {},
    entityVersions: Object.freeze([]),
    creatorStaffId: ACTOR.staffId,
    orgId: TENANT.orgId,
    storeId: TENANT.storeId,
    idempotencyKey: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae",
    createdAt,
    effectiveRisk: "R3",
    policyOutcome: "confirm",
    requiresOtherApprover: false,
  });

  for (const version of [undefined, "0.9.0"] as const) {
    const client = new FakeSqlClient();
    const result = await executeCommand(
      client,
      TENANT,
      "identity.logout",
      {},
      {
        actor: ACTOR,
        registry: setupRegistry(),
        pendingStore,
        confirmRef,
        now: FIXED_NOW,
        ...(version === undefined ? {} : { version }),
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "POLICY_DENIED");
    assert.equal(client.sqlSequence()[0], "BEGIN");
    assert.equal(client.sqlSequence().at(-1), "ROLLBACK");
    assert.equal(client.sqlSequence().includes(INSERT_AUDIT_LOG_SQL), false);
  }
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
