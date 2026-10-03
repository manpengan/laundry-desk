import assert from "node:assert/strict";
import test from "node:test";

import { CATALOG_SQL } from "./hk-vps-release-remote-db-evidence.mjs";
import {
  runCatalogMigrationChainAcceptance,
  runReleaseCatalogPgAcceptance,
} from "./hk-vps-release-catalog-pg-acceptance.mjs";

const ENVIRONMENT = Object.freeze({
  LAUNDRY_CLOUD_RELEASE_PG_TEST: "1",
  LAUNDRY_USE_LOCAL_PG: "1",
});
const FROM_HEAD = "0068_ai_approval_center.sql";
const TO_HEAD = "0069_bounded_automation.sql";
const CATALOG_ROWS = Object.freeze([{ value: JSON.stringify({ kind: "catalog_contract" }) }]);
const EVIDENCE = Object.freeze({
  entries: 663,
  sha256: "a".repeat(64),
  migrationHead: TO_HEAD,
});

const parseEvidence = (source, policy, state, requireCluster) => {
  assert.equal(source, `${JSON.stringify({ kind: "catalog_contract" })}\n`);
  assert.equal(policy, undefined);
  assert.equal(state, "stable");
  assert.equal(requireCluster, true);
  return EVIDENCE;
};

test("requires both explicit real PostgreSQL opt-ins before reading local config", async () => {
  let configReads = 0;
  await assert.rejects(
    runReleaseCatalogPgAcceptance({
      environment: { LAUNDRY_CLOUD_RELEASE_PG_TEST: "1" },
      ensureConfig: async () => {
        configReads += 1;
      },
    }),
    { code: "CLOUD_RELEASE_CATALOG_PG_OPT_IN_REQUIRED" },
  );
  assert.equal(configReads, 0);
});

test("verifies the isolated frozen catalog before the current database write gate", async () => {
  const calls = [];
  const createClient = () => assert.fail("top-level runner must not query the current catalog");
  const evidence = await runReleaseCatalogPgAcceptance({
    environment: ENVIRONMENT,
    ensureConfig: async ({ env }) => {
      assert.equal(env, ENVIRONMENT);
      return {
        postgresAppPassword: "app-test-secret",
        postgresSuperuserPassword: "catalog-test-secret",
      };
    },
    createClient,
    parseEvidence,
    verifyMigrationChain: async (options) => {
      calls.push("chain");
      assert.equal(options.password, "catalog-test-secret");
      assert.equal(options.parseEvidence, parseEvidence);
      assert.equal(options.createClient, createClient);
      return { from: { ...EVIDENCE, migrationHead: FROM_HEAD }, to: EVIDENCE };
    },
    verifyWriteGate: async (options) => {
      calls.push("write-gate");
      assert.equal(options.adminPassword, "catalog-test-secret");
      assert.equal(options.appPassword, "app-test-secret");
      assert.equal(options.createClient, createClient);
    },
  });
  assert.equal(evidence, EVIDENCE);
  assert.deepEqual(calls, ["chain", "write-gate"]);
});

test("isolated acceptance creates, migrates, verifies both heads, and drops its database", async () => {
  const events = [];
  const clients = new Map();
  const createClient = (configuration) => {
    const label = configuration.application_name;
    const client = {
      connect: async () => events.push(`${label}:connect`),
      query: async (sql, parameters) => {
        events.push({ label, sql, parameters });
        return sql === CATALOG_SQL ? { rows: CATALOG_ROWS } : { rows: [] };
      },
      end: async () => events.push(`${label}:end`),
    };
    clients.set(label, client);
    return client;
  };
  const heads = [FROM_HEAD, TO_HEAD];
  const result = await runCatalogMigrationChainAcceptance({
    password: "catalog-test-secret",
    createClient,
    listMigrationFiles: async () => [
      "0001_roles.sql",
      FROM_HEAD,
      TO_HEAD,
      "0079_miniapp_notifications.sql",
    ],
    loadMigration: async (filename) => {
      assert.ok(
        filename <= TO_HEAD,
        "new Windows migrations must remain outside frozen Cloud catalog",
      );
      return `SELECT '${filename}'`;
    },
    parseEvidence: (_source, _policy, state, requireCluster) => {
      assert.equal(state, "stable");
      assert.equal(requireCluster, true);
      return { migrationHead: heads.shift() };
    },
    randomToken: () => "1".repeat(16),
  });

  assert.equal(result.from.migrationHead, FROM_HEAD);
  assert.equal(result.to.migrationHead, TO_HEAD);
  const queries = events.filter((event) => typeof event === "object");
  assert.ok(queries.some((event) => event.sql.startsWith("CREATE DATABASE")));
  assert.equal(queries.filter((event) => event.sql === CATALOG_SQL).length, 2);
  assert.ok(queries.some((event) => event.sql.startsWith("DROP DATABASE")));
  assert.ok(events.includes("laundry-catalog-migrations:end"));
  assert.ok(events.includes("laundry-catalog-admin:end"));
  assert.equal(clients.size, 2);
});

test("missing historical heads and malformed newer filenames fail before connecting", async () => {
  for (const filenames of [
    ["0001_roles.sql", TO_HEAD, "0079_miniapp_notifications.sql"],
    ["0001_roles.sql", FROM_HEAD, TO_HEAD, "z-invalid.sql"],
  ]) {
    let connected = false;
    await assert.rejects(
      runCatalogMigrationChainAcceptance({
        password: "catalog-test-secret",
        createClient: () => ({
          connect: async () => {
            connected = true;
          },
          end: async () => undefined,
        }),
        listMigrationFiles: async () => filenames,
      }),
      (error) =>
        error.code === "CLOUD_RELEASE_CATALOG_PG_CHAIN_FAILED" &&
        error.cause?.code === "CLOUD_RELEASE_CATALOG_PG_MIGRATIONS_INVALID",
    );
    assert.equal(connected, false);
  }
});

for (const failurePoint of ["connect", "query", "end"]) {
  test(`isolated catalog closes owned resources after a ${failurePoint} failure`, async () => {
    const events = [];
    const createClient = (configuration) => {
      const isMigration = configuration.application_name === "laundry-catalog-migrations";
      return {
        connect: async () => {
          events.push(isMigration ? "migration-connect" : "admin-connect");
          if (isMigration && failurePoint === "connect")
            throw new Error("sensitive connection failure");
        },
        query: async (sql) => {
          events.push(sql.startsWith("DROP DATABASE") ? "drop-owned" : "query");
          if (isMigration && failurePoint === "query") throw new Error("sensitive query failure");
          return sql === CATALOG_SQL ? { rows: CATALOG_ROWS } : { rows: [] };
        },
        end: async () => {
          events.push(isMigration ? "migration-end" : "admin-end");
          if (isMigration && failurePoint === "end") throw new Error("sensitive cleanup failure");
        },
      };
    };
    const heads = [FROM_HEAD, TO_HEAD];
    await assert.rejects(
      runCatalogMigrationChainAcceptance({
        password: "catalog-test-secret",
        createClient,
        listMigrationFiles: async () => ["0001_roles.sql", FROM_HEAD, TO_HEAD],
        loadMigration: async () => "SELECT 1",
        parseEvidence: () => ({ migrationHead: heads.shift() }),
        randomToken: () => "1".repeat(16),
      }),
      {
        code:
          failurePoint === "end"
            ? "CLOUD_RELEASE_CATALOG_PG_CLEANUP_FAILED"
            : "CLOUD_RELEASE_CATALOG_PG_CHAIN_FAILED",
      },
    );
    assert.ok(events.includes("drop-owned"));
    assert.ok(events.includes("migration-end"));
    assert.ok(events.includes("admin-end"));
  });
}

test("a frozen catalog failure never enters the current database write gate", async () => {
  let gated = false;
  await assert.rejects(
    runReleaseCatalogPgAcceptance({
      environment: ENVIRONMENT,
      ensureConfig: async () => ({ postgresSuperuserPassword: "catalog-test-secret" }),
      verifyMigrationChain: async () => {
        throw new Error("catalog rejected");
      },
      verifyWriteGate: async () => {
        gated = true;
      },
    }),
    { code: "CLOUD_RELEASE_CATALOG_PG_ACCEPTANCE_FAILED" },
  );
  assert.equal(gated, false);
});

test("a current database write gate failure cannot report the historical catalog as success", async () => {
  await assert.rejects(
    runReleaseCatalogPgAcceptance({
      environment: ENVIRONMENT,
      ensureConfig: async () => ({ postgresSuperuserPassword: "catalog-test-secret" }),
      verifyMigrationChain: async () => ({ to: EVIDENCE }),
      verifyWriteGate: async () => {
        throw new Error("write gate rejected");
      },
    }),
    { code: "CLOUD_RELEASE_CATALOG_PG_ACCEPTANCE_FAILED" },
  );
});
