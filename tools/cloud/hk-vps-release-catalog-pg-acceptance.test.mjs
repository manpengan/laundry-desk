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
const FROM_HEAD = "0056_delivery_orders.sql";
const TO_HEAD = "0057_delivery_tasks.sql";
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

test("queries stable catalog and proves the isolated 0056 to 0057 migration chain", async () => {
  const calls = [];
  const evidence = await runReleaseCatalogPgAcceptance({
    environment: ENVIRONMENT,
    ensureConfig: async ({ env }) => {
      assert.equal(env, ENVIRONMENT);
      return {
        postgresAppPassword: "app-test-secret",
        postgresSuperuserPassword: "catalog-test-secret",
      };
    },
    createClient: (configuration) => {
      calls.push({ type: "configuration", configuration });
      return {
        connect: async () => calls.push({ type: "connect" }),
        query: async (sql) => {
          calls.push({ type: "query", sql });
          return { rows: CATALOG_ROWS };
        },
        end: async () => calls.push({ type: "end" }),
      };
    },
    parseEvidence,
    verifyMigrationChain: async (options) => {
      calls.push({ type: "chain", options });
      assert.equal(options.password, "catalog-test-secret");
      assert.equal(options.parseEvidence, parseEvidence);
    },
    verifyWriteGate: async (options) => {
      calls.push({ type: "write-gate", options });
      assert.equal(options.adminPassword, "catalog-test-secret");
      assert.equal(options.appPassword, "app-test-secret");
    },
  });

  assert.equal(evidence, EVIDENCE);
  const configuration = calls[0].configuration;
  assert.equal(configuration.application_name, "laundry-release-catalog-acceptance");
  assert.equal(new URL(configuration.connectionString).hostname, "127.0.0.1");
  assert.equal(new URL(configuration.connectionString).port, "8543");
  assert.equal(new URL(configuration.connectionString).username, "postgres");
  assert.equal(new URL(configuration.connectionString).password, "catalog-test-secret");
  assert.deepEqual(
    calls.slice(1).map((call) => call.type),
    ["connect", "query", "chain", "write-gate", "end"],
  );
  assert.equal(calls[2].sql, CATALOG_SQL);
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
    listMigrationFiles: async () => ["0001_roles.sql", FROM_HEAD, TO_HEAD],
    loadMigration: async (filename) => `SELECT '${filename}'`,
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

test("closes the PostgreSQL client after a catalog query failure", async () => {
  let closed = false;
  await assert.rejects(
    runReleaseCatalogPgAcceptance({
      environment: ENVIRONMENT,
      ensureConfig: async () => ({ postgresSuperuserPassword: "catalog-test-secret" }),
      createClient: () => ({
        connect: async () => undefined,
        query: async () => {
          throw new Error("sensitive database failure");
        },
        end: async () => {
          closed = true;
        },
      }),
      parseEvidence,
      verifyMigrationChain: async () => undefined,
      verifyWriteGate: async () => undefined,
    }),
    { code: "CLOUD_RELEASE_CATALOG_PG_ACCEPTANCE_FAILED" },
  );
  assert.equal(closed, true);
});

test("closes the PostgreSQL client after a partial connection failure", async () => {
  let closed = false;
  let queried = false;
  await assert.rejects(
    runReleaseCatalogPgAcceptance({
      environment: ENVIRONMENT,
      ensureConfig: async () => ({ postgresSuperuserPassword: "catalog-test-secret" }),
      createClient: () => ({
        connect: async () => {
          throw new Error("sensitive partial connection failure");
        },
        query: async () => {
          queried = true;
        },
        end: async () => {
          closed = true;
        },
      }),
      parseEvidence,
      verifyMigrationChain: async () => undefined,
      verifyWriteGate: async () => undefined,
    }),
    { code: "CLOUD_RELEASE_CATALOG_PG_ACCEPTANCE_FAILED" },
  );
  assert.equal(queried, false);
  assert.equal(closed, true);
});

test("fails closed when the PostgreSQL connection cannot be closed", async () => {
  await assert.rejects(
    runReleaseCatalogPgAcceptance({
      environment: ENVIRONMENT,
      ensureConfig: async () => ({ postgresSuperuserPassword: "catalog-test-secret" }),
      createClient: () => ({
        connect: async () => undefined,
        query: async () => ({ rows: CATALOG_ROWS }),
        end: async () => {
          throw new Error("sensitive cleanup failure");
        },
      }),
      parseEvidence,
      verifyMigrationChain: async () => undefined,
      verifyWriteGate: async () => undefined,
    }),
    { code: "CLOUD_RELEASE_CATALOG_PG_CLEANUP_FAILED" },
  );
});
