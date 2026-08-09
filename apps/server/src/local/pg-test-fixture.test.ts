import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import type { PasswordPort } from "../identity/password.js";
import { parsePgTestFixtureEnvironment, seedPgTestIdentityFixture } from "./pg-test-fixture.js";

const TEST_ENV = Object.freeze({
  LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "ci-admin",
  LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME: "CI Administrator",
  LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: "unique-ci-password",
  LAUNDRY_BOOTSTRAP_ADMIN_PIN: "846291",
  LAUNDRY_BOOTSTRAP_APPROVER_USERNAME: "ci-approver",
  LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME: "CI Approval Administrator",
  LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD: "independent-ci-approver-password",
  LAUNDRY_BOOTSTRAP_APPROVER_PIN: "729463",
});

type RecordedQuery = Readonly<{
  sql: string;
  params: readonly unknown[] | undefined;
}>;

function createCapturingPool(): Readonly<{ pool: PgPool; queries: RecordedQuery[] }> {
  const queries: RecordedQuery[] = [];
  const client = {
    async query(
      sql: string,
      params?: readonly unknown[],
    ): Promise<{ rows: readonly unknown[]; rowCount: number }> {
      queries.push(Object.freeze({ sql, params }));
      return { rows: [], rowCount: 1 };
    },
    release(): void {
      // Capturing test double.
    },
  } as unknown as PgPoolClient;
  return Object.freeze({
    pool: { connect: async () => client } as unknown as PgPool,
    queries,
  });
}

const passwordPort: PasswordPort = Object.freeze({
  hashPassword: async (value) => `$argon2id$fixture$${Buffer.from(value).toString("base64url")}`,
  verifyPassword: async () => false,
});

test("PG test fixture rejects every missing ephemeral credential", async (t) => {
  for (const key of Object.keys(TEST_ENV)) {
    await t.test(key, () => {
      const env = { ...TEST_ENV, [key]: undefined };
      assert.throws(() => parsePgTestFixtureEnvironment(env), new RegExp(key, "u"));
    });
  }
});

test("PG test fixture hashes environment credentials before writing test-only staff", async () => {
  const { pool, queries } = createCapturingPool();
  const fixture = await seedPgTestIdentityFixture(pool, TEST_ENV, { passwordPort });

  assert.equal(fixture.adminUsername, TEST_ENV.LAUNDRY_BOOTSTRAP_ADMIN_USERNAME);
  assert.equal(fixture.adminPassword, TEST_ENV.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD);
  assert.equal(fixture.adminPin, TEST_ENV.LAUNDRY_BOOTSTRAP_ADMIN_PIN);
  assert.equal(fixture.approverUsername, TEST_ENV.LAUNDRY_BOOTSTRAP_APPROVER_USERNAME);
  assert.equal(fixture.approverPassword, TEST_ENV.LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD);
  assert.equal(fixture.approverPin, TEST_ENV.LAUNDRY_BOOTSTRAP_APPROVER_PIN);

  const staffWrites = queries.filter((query) => query.sql.includes("INSERT INTO staffs"));
  assert.equal(staffWrites.length, 2);
  const writtenValues = staffWrites.flatMap((query) => query.params ?? []);
  assert.equal(writtenValues.includes(TEST_ENV.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD), false);
  assert.equal(writtenValues.includes(TEST_ENV.LAUNDRY_BOOTSTRAP_ADMIN_PIN), false);
  assert.equal(writtenValues.includes(TEST_ENV.LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD), false);
  assert.equal(writtenValues.includes(TEST_ENV.LAUNDRY_BOOTSTRAP_APPROVER_PIN), false);
  assert.equal(writtenValues.includes("demo"), false);
  assert.equal(writtenValues.includes("1234"), false);
  assert.ok(
    writtenValues.some(
      (value) => typeof value === "string" && value.startsWith("$argon2id$fixture$"),
    ),
  );
});
