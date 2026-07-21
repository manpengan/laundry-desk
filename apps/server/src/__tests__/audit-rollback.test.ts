import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { auditWriterIsInsertOnly, INSERT_AUDIT_LOG_SQL, writeAudit } from "../audit/write-audit.js";
import { createM1CommandRegistry } from "../bus/registry.js";
import { executeCommand } from "../bus/executor.js";
import type { ActorContext, CommandHandler } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});

const ACTOR: ActorContext = Object.freeze({
  staffId: TENANT.staffId,
  deviceId: null,
  via: "ui" as const,
});

test("auditWriterIsInsertOnly accepts INSERT and rejects UPDATE/DELETE", () => {
  assert.equal(auditWriterIsInsertOnly(INSERT_AUDIT_LOG_SQL), true);
  assert.equal(auditWriterIsInsertOnly("UPDATE audit_log SET via = $1"), false);
  assert.equal(auditWriterIsInsertOnly("DELETE FROM audit_log WHERE id = $1"), false);
  assert.equal(auditWriterIsInsertOnly("TRUNCATE audit_log"), false);
});

test("writeAudit issues the fixed INSERT SQL with bound params", async () => {
  const client = new FakeSqlClient();
  await writeAudit(client, {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    orgId: TENANT.orgId,
    storeId: TENANT.storeId,
    staffId: TENANT.staffId,
    via: "ui",
    command: "identity.logout",
    idempotencyKey: null,
    dryRun: false,
    entity: "session",
    entityId: "s1",
    beforeJson: null,
    afterJson: null,
    ip: null,
    deviceId: null,
    at: new Date("2026-07-21T12:00:00.000Z"),
  });
  assert.equal(client.queries.length, 1);
  assert.equal(client.queries[0]?.sql, INSERT_AUDIT_LOG_SQL);
  assert.equal(client.queries[0]?.params?.[5], "identity.logout");
});

test("business success + audit failure → TRANSACTION_FAILED and ROLLBACK", async () => {
  const client = new FakeSqlClient();
  client.failOn(INSERT_AUDIT_LOG_SQL);

  let handlerMutations = 0;
  const handler: CommandHandler = async ({ client: tx }) => {
    handlerMutations += 1;
    await tx.query("UPDATE settings SET value_json = $1 WHERE key = $2", ["x", "k"]);
    return {
      result: { ok: true },
      audit: { entity: "settings", entityId: "k" },
    };
  };

  const registry = createM1CommandRegistry();
  registry.registerHandler("identity.logout", handler);

  const result = await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      now: () => new Date("2026-07-21T12:00:00.000Z"),
      newId: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    },
  );

  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.error.code, "TRANSACTION_FAILED");
  }
  assert.equal(handlerMutations, 1);
  const seq = client.sqlSequence();
  assert.equal(seq[0], "BEGIN");
  assert.equal(seq.includes("COMMIT"), false);
  assert.equal(seq.at(-1), "ROLLBACK");
  assert.ok(seq.some((s) => s.startsWith("UPDATE settings")));
});

test("events are not published when audit rolls back", async () => {
  const client = new FakeSqlClient();
  client.failOn(INSERT_AUDIT_LOG_SQL);
  let published = 0;

  const registry = createM1CommandRegistry();
  registry.registerHandler("identity.logout", async () => ({
    result: {},
    events: [{ type: "should.not.publish", payload: {} }],
  }));

  await executeCommand(
    client,
    TENANT,
    "identity.logout",
    {},
    {
      actor: ACTOR,
      registry,
      eventBus: {
        publish: () => {
          published += 1;
        },
      },
    },
  );

  assert.equal(published, 0);
  assert.equal(client.sqlSequence().at(-1), "ROLLBACK");
});

test("laundry_app grant model: audit_log is INSERT-only in migration SQL", () => {
  const migrationsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../packages/db/src/migrations",
  );
  const grants = readFileSync(join(migrationsDir, "0003_rls_and_grants.sql"), "utf8");

  assert.match(grants, /GRANT SELECT, INSERT ON TABLE audit_log TO laundry_app/iu);
  // No UPDATE/DELETE/TRUNCATE privilege for laundry_app on audit_log
  assert.equal(/GRANT[^;]*UPDATE[^;]*audit_log[^;]*laundry_app/iu.test(grants), false);
  assert.equal(/GRANT[^;]*DELETE[^;]*audit_log[^;]*laundry_app/iu.test(grants), false);
  assert.equal(/GRANT[^;]*TRUNCATE[^;]*audit_log[^;]*laundry_app/iu.test(grants), false);
  // Writer SQL itself is insert-only
  assert.equal(auditWriterIsInsertOnly(INSERT_AUDIT_LOG_SQL), true);
});
