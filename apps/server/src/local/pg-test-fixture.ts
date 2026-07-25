/**
 * Real-PostgreSQL test fixture. This module may be imported only by *.test.ts.
 * The explicit bootstrap command creates the administrator; this helper adds
 * fictional secondary staff required by integration tests.
 */

import { z } from "zod";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { createPasswordPort, type PasswordPort } from "../identity/password.js";
import { DEMO_STAFF_A_ID, DEMO_STAFF_B_ID } from "./demo-ids.js";
import { LOCAL_PROFILE } from "./profile.js";

const PgTestFixtureEnvironmentSchema = z.object({
  LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: z.string().min(1, "is required"),
  LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME: z.string().min(1, "is required"),
  LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(1, "is required"),
  LAUNDRY_BOOTSTRAP_ADMIN_PIN: z.string().regex(/^\d{4,8}$/u, "must contain 4 to 8 digits"),
});

export type PgTestFixtureEnvironment = Readonly<{
  adminUsername: string;
  adminDisplayName: string;
  adminPassword: string;
  adminPin: string;
}>;

export type PgTestFixtureDependencies = Readonly<{
  passwordPort?: PasswordPort;
  now?: () => Date;
}>;

type FixtureStaff = Readonly<{
  id: string;
  username: string;
  displayName: string;
}>;

const FIXTURE_STAFF: readonly FixtureStaff[] = Object.freeze([
  Object.freeze({ id: DEMO_STAFF_A_ID, username: "staff", displayName: "Fixture Staff A" }),
  Object.freeze({ id: DEMO_STAFF_B_ID, username: "staffb", displayName: "Fixture Staff B" }),
]);

function fixtureEnvironmentError(error: z.ZodError): Error {
  const details = error.issues
    .map((issue) => `${String(issue.path[0] ?? "environment")}: ${issue.message}`)
    .join("; ");
  return new Error(`Invalid PostgreSQL test fixture environment: ${details}`);
}

export function parsePgTestFixtureEnvironment(env: NodeJS.ProcessEnv): PgTestFixtureEnvironment {
  const result = PgTestFixtureEnvironmentSchema.safeParse(env);
  if (!result.success) {
    throw fixtureEnvironmentError(result.error);
  }
  return Object.freeze({
    adminUsername: result.data.LAUNDRY_BOOTSTRAP_ADMIN_USERNAME,
    adminDisplayName: result.data.LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME,
    adminPassword: result.data.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD,
    adminPin: result.data.LAUNDRY_BOOTSTRAP_ADMIN_PIN,
  });
}

async function insertFixtureStaff(
  client: PgPoolClient,
  row: FixtureStaff,
  passwordHash: string,
  pinHash: string,
  now: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO staffs (
       id, org_id, username, password_hash, pin_hash, display_name,
       is_active, permission_version, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, true, 1, $7, $7)
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       password_hash = EXCLUDED.password_hash,
       pin_hash = EXCLUDED.pin_hash,
       display_name = EXCLUDED.display_name,
       is_active = true,
       updated_at = EXCLUDED.updated_at`,
    [row.id, LOCAL_PROFILE.orgId, row.username, passwordHash, pinHash, row.displayName, now],
  );

  const roleId = `55555555-5555-4555-8555-${row.id.slice(-12)}`;
  await client.query(
    `INSERT INTO staff_store_roles (
       id, org_id, store_id, staff_id, role, is_active, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'staff', true, $5, $5)
     ON CONFLICT (id) DO UPDATE SET is_active = true, updated_at = EXCLUDED.updated_at`,
    [roleId, LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId, row.id, now],
  );
}

async function rollbackPreservingCause(client: PgPoolClient, cause: unknown): Promise<never> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original fixture failure is the actionable test error.
  }
  throw cause;
}

export async function seedPgTestIdentityFixture(
  pool: PgPool,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: PgTestFixtureDependencies = {},
): Promise<PgTestFixtureEnvironment> {
  const fixture = parsePgTestFixtureEnvironment(env);
  const passwordPort = dependencies.passwordPort ?? createPasswordPort();
  const [passwordHash, pinHash] = await Promise.all([
    passwordPort.hashPassword(fixture.adminPassword),
    passwordPort.hashPassword(fixture.adminPin),
  ]);
  const now = (dependencies.now ?? (() => new Date()))();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE laundry_owner");
      for (const row of FIXTURE_STAFF) {
        await insertFixtureStaff(client, row, passwordHash, pinHash, now);
      }
      await client.query("COMMIT");
    } catch (error) {
      return await rollbackPreservingCause(client, error);
    }
  } finally {
    client.release();
  }
  return fixture;
}
