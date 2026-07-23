import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryAiCredentialStore,
  createPgAiCredentialStore,
  createStaticKekProvider,
  decryptApiKey,
  encryptApiKey,
} from "./byok-store.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { QueryResult, SqlClient } from "../db/types.js";

const TENANT = Object.freeze({
  orgId: "11111111-1111-4111-8111-111111111111",
  storeId: "22222222-2222-4222-8222-222222222222",
  staffId: "33333333-3333-4333-8333-333333333333",
});

const KEK = createStaticKekProvider("test-v1", Buffer.alloc(32, 7));

test("BYOK encryption uses an independent DEK, unique nonce, and credential-bound AAD", () => {
  const first = encryptApiKey({
    apiKey: "sk-test-never-log-1234",
    credentialId: "44444444-4444-4444-8444-444444444444",
    orgId: TENANT.orgId,
    provider: "openai",
    kekProvider: KEK,
  });
  const second = encryptApiKey({
    apiKey: "sk-test-never-log-1234",
    credentialId: "55555555-5555-4555-8555-555555555555",
    orgId: TENANT.orgId,
    provider: "openai",
    kekProvider: KEK,
  });

  assert.notEqual(first.key_ciphertext, second.key_ciphertext);
  assert.notEqual(first.key_nonce, second.key_nonce);
  assert.equal(first.last4, "1234");
  assert.equal(JSON.stringify(first).includes("sk-test-never-log-1234"), false);
  assert.equal(
    decryptApiKey({ credential: first, orgId: TENANT.orgId, provider: "openai", kekProvider: KEK }),
    "sk-test-never-log-1234",
  );
  assert.throws(
    () =>
      decryptApiKey({
        credential: first,
        orgId: "66666666-6666-4666-8666-666666666666",
        provider: "openai",
        kekProvider: KEK,
      }),
    /authentication failed/iu,
  );
});

test("credential store returns metadata only and never exposes a saved API key", async () => {
  const store = createMemoryAiCredentialStore();
  const encrypted = encryptApiKey({
    apiKey: "sk-test-never-log-1234",
    credentialId: "44444444-4444-4444-8444-444444444444",
    orgId: TENANT.orgId,
    provider: "openai",
    kekProvider: KEK,
  });

  await store.save(TENANT, encrypted);
  const list = await store.list(TENANT);
  assert.deepEqual(list, [
    {
      credential_id: encrypted.credential_id,
      provider: "openai",
      last4: "1234",
      key_version: "test-v1",
      status: "unverified",
    },
  ]);
  assert.equal(JSON.stringify(list).includes("sk-test-never-log-1234"), false);
});

test("PostgreSQL credential store uses the injected tenant transaction and records no plaintext", async () => {
  const encrypted = encryptApiKey({
    apiKey: "sk-test-never-log-1234",
    credentialId: "44444444-4444-4444-8444-444444444444",
    orgId: TENANT.orgId,
    provider: "openai",
    kekProvider: KEK,
  });
  const calls: Readonly<{ sql: string; params: readonly unknown[] | undefined }>[] = [];
  const store = createPgAiCredentialStore(async (tenant, operation) => {
    assert.deepEqual(tenant, TENANT);
    return operation({
      query: async (sql, params) => {
        calls.push(Object.freeze({ sql, params }));
        return Object.freeze({ rows: [], rowCount: 1 });
      },
    });
  });

  await store.save(TENANT, encrypted);
  assert.equal(calls.length, 2);
  assert.match(calls[0]?.sql ?? "", /INSERT INTO ai_credentials/u);
  assert.match(calls[1]?.sql ?? "", /INSERT INTO ai_credential_events/u);
  assert.equal(JSON.stringify(calls).includes("sk-test-never-log-1234"), false);
  assert.equal(JSON.stringify(calls).includes(encrypted.key_ciphertext), true);
});

test("credential and append-only event roll back together when the event insert fails", async () => {
  const encrypted = encryptApiKey({
    apiKey: "sk-test-never-log-1234",
    credentialId: "44444444-4444-4444-8444-444444444444",
    orgId: TENANT.orgId,
    provider: "openai",
    kekProvider: KEK,
  });
  const sql: string[] = [];
  const client: SqlClient = Object.freeze({
    async query<TRow>(statement: string): Promise<QueryResult<TRow>> {
      sql.push(statement);
      if (statement.includes("INSERT INTO ai_credential_events")) {
        throw new Error("forced event failure");
      }
      return Object.freeze({ rows: Object.freeze([]) as readonly TRow[], rowCount: 1 });
    },
  });
  const store = createPgAiCredentialStore((tenant, operation) =>
    withTenantTransaction(client, tenant, operation),
  );

  await assert.rejects(() => store.save(TENANT, encrypted), /forced event failure/u);
  assert.equal(sql[0], "BEGIN");
  assert.ok(sql.some((statement) => statement.includes("set_config('app.org_id'")));
  assert.ok(sql.some((statement) => statement.includes("INSERT INTO ai_credentials")));
  assert.equal(sql.at(-1), "ROLLBACK");
});
