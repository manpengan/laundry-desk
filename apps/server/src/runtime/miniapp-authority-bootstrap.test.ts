import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { PgPool } from "../db/pg-pool.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { deriveMiniappProfileAuthorityKey } from "../customer-miniapp/profile-authority.js";
import { prepareMiniappProfileAuthority } from "./miniapp-authority-bootstrap.js";

const secret = "synthetic-runtime-profile-secret-at-least-32-bytes";
function fixture(rejectWrite = false) {
  const calls: string[] = [];
  let values: readonly unknown[] = [];
  let key: Buffer | undefined;
  let sentKey: Buffer | undefined;
  let released = false;
  const pool = {
    connect: async () => ({
      query: async (text: string, parameters?: readonly unknown[]) => {
        calls.push(text);
        if (text.startsWith("INSERT")) {
          values = parameters ?? [];
          assert.ok(Buffer.isBuffer(values[2]));
          key = values[2];
          sentKey = Buffer.from(key);
          if (rejectWrite) throw new Error(`SQL includes forbidden ${secret}`);
        }
        return { rows: [] };
      },
      release: () => {
        released = true;
      },
    }),
  } as unknown as PgPool;
  return {
    pool,
    calls,
    values: () => values,
    key: () => key,
    sentKey: () => sentKey,
    released: () => released,
  };
}
test("owner preparation binds fixed local identity, parameterizes and wipes its derived key", async () => {
  const fake = fixture();
  await prepareMiniappProfileAuthority(fake.pool, secret);
  assert.deepEqual(fake.calls.slice(0, 2), ["BEGIN", "SET LOCAL ROLE laundry_owner"]);
  assert.equal(fake.calls.at(-1), "COMMIT");
  assert.deepEqual(fake.values().slice(0, 2), [LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId]);
  const expected = deriveMiniappProfileAuthorityKey(secret);
  try {
    assert.deepEqual(fake.sentKey(), expected);
  } finally {
    expected.fill(0);
  }
  assert.deepEqual(fake.key(), Buffer.alloc(32));
  assert.equal(fake.released(), true);
  assert.equal(
    fake.calls.some((text) => text.includes(secret)),
    false,
  );
});
test("failed preparation rolls back, wipes material and returns only a stable error", async () => {
  const fake = fixture(true);
  await assert.rejects(prepareMiniappProfileAuthority(fake.pool, secret), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "RUNTIME_MINIAPP_AUTHORITY_FAILED");
    assert.doesNotMatch(error.stack ?? "", /synthetic-runtime-profile-secret/u);
    return true;
  });
  assert.equal(fake.calls.at(-1), "ROLLBACK");
  assert.deepEqual(fake.key(), Buffer.alloc(32));
  assert.equal(fake.released(), true);
  const invalid = fixture();
  await assert.rejects(
    prepareMiniappProfileAuthority(invalid.pool, "short"),
    /RUNTIME_MINIAPP_AUTHORITY_FAILED/u,
  );
  assert.equal(invalid.calls.length, 0);
});
test("only trusted verified schema initialization invokes owner preparation", () => {
  const source = readFileSync(
    new URL("../../src/runtime/kit-entrypoint.ts", import.meta.url),
    "utf8",
  );
  const verify = source.slice(source.indexOf("const runVerify"), source.indexOf("const runServer"));
  assert.ok(
    verify.indexOf("verifyRuntimeMigrationLedger") <
      verify.indexOf("prepareMiniappProfileAuthority"),
  );
  assert.match(verify, /entry\.filename === "0078_miniapp_transactions\.sql"/u);
  assert.match(verify, /requiredFileSecret\("LAUNDRY_ACCESS_TOKEN_SECRET"\)/u);
  const server = source.slice(
    source.indexOf("const runServer"),
    source.indexOf("const runMigrationInfo"),
  );
  assert.doesNotMatch(server, /DATABASE_ADMIN|prepareMiniappProfileAuthority/u);
});
