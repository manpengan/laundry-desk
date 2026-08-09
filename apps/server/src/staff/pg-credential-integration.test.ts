import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  AccessSessionResponseSchema,
  CSRF_HEADER_NAME,
  StaffCredentialSetupResultSchema,
  StaffCredentialsCompleteResponseSchema,
} from "@laundry/contracts";
import type { FastifyInstance } from "fastify";

import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { buildSetLocalGucStatements } from "../db/guc.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createLocalApp } from "../http/create-app.js";
import { resolveCookiePolicy } from "../http/cookie-policy.js";
import { LOCAL_COOKIE_NAMES } from "../http/types.js";
import { createPasswordPort } from "../identity/password.js";
import { BOOTSTRAP_APPROVER_STAFF_ID, bootstrapLocalIdentity } from "../local/bootstrap.js";
import type { LocalServerConfig } from "../local/config.js";
import { createPgLocalRuntime } from "../local/create-runtime.js";
import { parsePgTestFixtureEnvironment } from "../local/pg-test-fixture.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { createSqlStaffAccessStore } from "./access-store.js";
import { createSqlStaffCredentialStore } from "./sql-credential-store.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;
const BROWSER_HEADERS = Object.freeze({
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});
const TEST_CONFIG: LocalServerConfig = Object.freeze({
  listenHost: "127.0.0.1",
  port: 8787,
  browserOrigin: "http://127.0.0.1:5173",
  browserFetchSite: "same-site",
  cookieSecure: false,
  hostAuthorities: Object.freeze(["127.0.0.1:8787"] as const),
  accessTokenSecret: "staff-pg-access-token-secret-32-bytes-minimum",
  csrfProofSecret: "staff-pg-csrf-proof-secret-independent-value",
});
const TENANT: TenantContext = Object.freeze({
  orgId: LOCAL_PROFILE.orgId,
  storeId: LOCAL_PROFILE.storeId,
  staffId: LOCAL_PROFILE.adminStaffId,
});

type AuthenticatedBrowser = Readonly<{
  accessToken: string;
  cookieHeader: string;
  csrf: string;
  sessionId: string;
}>;

function cookiesFrom(headers: Record<string, unknown>): Readonly<Record<string, string>> {
  const raw = headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return Object.freeze(
    Object.fromEntries(
      values.flatMap((line) => {
        const pair = line.split(";", 1)[0];
        const separator = pair?.indexOf("=") ?? -1;
        return pair === undefined || separator <= 0
          ? []
          : [[pair.slice(0, separator), pair.slice(separator + 1)]];
      }),
    ),
  );
}

function authenticatedHeaders(auth: AuthenticatedBrowser) {
  return Object.freeze({
    ...BROWSER_HEADERS,
    authorization: `Bearer ${auth.accessToken}`,
    cookie: auth.cookieHeader,
    [CSRF_HEADER_NAME]: auth.csrf,
  });
}

async function login(
  app: FastifyInstance,
  username: string,
  password: string,
  deviceId: string,
): Promise<AuthenticatedBrowser> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: BROWSER_HEADERS,
    payload: {
      org_code: LOCAL_PROFILE.orgCode,
      store_code: LOCAL_PROFILE.storeCode,
      username,
      password,
      device_id: deviceId,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const access = AccessSessionResponseSchema.parse(
    (response.json() as Readonly<{ data: unknown }>).data,
  );
  const cookies = cookiesFrom(response.headers as Record<string, unknown>);
  return Object.freeze({
    accessToken: access.access_token,
    cookieHeader: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
    csrf: cookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
    sessionId: access.session.session_id,
  });
}

async function expectLoginRejected(
  app: FastifyInstance,
  username: string,
  password: string,
  deviceId: string,
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: BROWSER_HEADERS,
    payload: {
      org_code: LOCAL_PROFILE.orgCode,
      store_code: LOCAL_PROFILE.storeCode,
      username,
      password,
      device_id: deviceId,
    },
  });
  assert.equal(response.statusCode, 401, response.body);
  assert.equal(
    (response.json() as Readonly<{ error?: Readonly<{ code?: string }> }>).error?.code,
    "AUTHENTICATION_FAILED",
  );
}

async function executeR5StaffCommand(
  app: FastifyInstance,
  actor: AuthenticatedBrowser,
  approverStaffId: string,
  approverPin: string,
  name: "staff.create" | "staff.credentials.reset",
  input: Readonly<Record<string, unknown>>,
) {
  const gated = await app.inject({
    method: "POST",
    url: `/v1/commands/${name}`,
    headers: authenticatedHeaders(actor),
    payload: input,
  });
  assert.equal(gated.statusCode, 403, gated.body);
  const gate = gated.json() as Readonly<{
    error?: Readonly<{
      code?: string;
      detail?: Readonly<{ kind?: string; confirm_ref?: string }>;
    }>;
  }>;
  assert.equal(gate.error?.code, "POLICY_STEP_UP_REQUIRED");
  assert.equal(gate.error?.detail?.kind, "confirmation");
  const confirmRef = gate.error?.detail?.confirm_ref;
  assert.equal(typeof confirmRef, "string", gated.body);
  if (confirmRef === undefined) throw new Error("Missing R5 confirmation reference");

  const challenge = await app.inject({
    method: "POST",
    url: "/api/v2/auth/pin/challenges",
    headers: authenticatedHeaders(actor),
    payload: {
      purpose: "step_up",
      pending_action_ref: confirmRef,
      approver_staff_id: approverStaffId,
    },
  });
  assert.equal(challenge.statusCode, 200, challenge.body);
  const challengeId = (challenge.json() as Readonly<{ data?: Readonly<{ challenge_id?: string }> }>)
    .data?.challenge_id;
  assert.equal(typeof challengeId, "string", challenge.body);
  if (challengeId === undefined) throw new Error("Missing R5 PIN challenge");

  const verified = await app.inject({
    method: "POST",
    url: `/api/v2/auth/pin/challenges/${challengeId}/verify`,
    headers: authenticatedHeaders(actor),
    payload: { challenge_id: challengeId, pin: approverPin },
  });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(
    typeof (verified.json() as { data?: { step_up_proof_id?: unknown } }).data?.step_up_proof_id,
    "string",
  );

  const confirmed = await app.inject({
    method: "POST",
    url: `/v1/commands/${name}`,
    headers: authenticatedHeaders(actor),
    payload: { confirm_ref: confirmRef },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  const setup = StaffCredentialSetupResultSchema.parse(
    (confirmed.json() as Readonly<{ data: Readonly<{ result: unknown }> }>).data.result,
  );
  return Object.freeze({ setup, confirmRef });
}

async function completeCredentials(
  app: FastifyInstance,
  actor: AuthenticatedBrowser,
  setupRef: string,
  password: string,
  pin: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/v2/auth/staff/credentials/complete",
    headers: authenticatedHeaders(actor),
    payload: { credential_setup_ref: setupRef, password, pin },
  });
}

async function cleanupEvidence(
  pool: PgPool,
  targetIds: readonly string[],
  pendingRefs: readonly string[],
  sessionIds: readonly string[],
  storeIds: readonly string[],
): Promise<void> {
  await pool.query(
    `DELETE FROM refresh_tokens
      WHERE session_id IN (
        SELECT id FROM sessions WHERE id = ANY($1::uuid[]) OR staff_id = ANY($2::uuid[])
      )`,
    [sessionIds, targetIds],
  );
  await pool.query(
    `DELETE FROM refresh_families
      WHERE session_id IN (
        SELECT id FROM sessions WHERE id = ANY($1::uuid[]) OR staff_id = ANY($2::uuid[])
      )`,
    [sessionIds, targetIds],
  );
  await pool.query(
    `DELETE FROM step_up_proofs
      WHERE pending_action_ref = ANY($1::uuid[]) OR session_id = ANY($2::uuid[])`,
    [pendingRefs, sessionIds],
  );
  await pool.query(
    `DELETE FROM pin_challenges
      WHERE pending_action_ref = ANY($1::text[]) OR session_id = ANY($2::uuid[])`,
    [pendingRefs, sessionIds],
  );
  await pool.query(
    `DELETE FROM audit_log
      WHERE entity_id = ANY($1::text[]) OR idempotency_key = ANY($2::text[])`,
    [targetIds, pendingRefs],
  );
  await pool.query("DELETE FROM command_idempotency WHERE idempotency_key = ANY($1::uuid[])", [
    pendingRefs,
  ]);
  await pool.query("DELETE FROM ai_pending_actions WHERE nonce = ANY($1::uuid[])", [pendingRefs]);
  await pool.query("DELETE FROM staff_credential_setups WHERE staff_id = ANY($1::uuid[])", [
    targetIds,
  ]);
  await pool.query(
    "DELETE FROM sessions WHERE id = ANY($1::uuid[]) OR staff_id = ANY($2::uuid[])",
    [sessionIds, targetIds],
  );
  await pool.query("DELETE FROM staff_store_roles WHERE staff_id = ANY($1::uuid[])", [targetIds]);
  await pool.query("DELETE FROM staffs WHERE id = ANY($1::uuid[])", [targetIds]);
  await pool.query("DELETE FROM stores WHERE id = ANY($1::uuid[])", [storeIds]);
}

maybe("real PG staff credential lifecycle is recoverable, isolated and secret-free", async () => {
  assert.ok(urls);
  const fixture = parsePgTestFixtureEnvironment(process.env);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const targetIds: string[] = [];
  const pendingRefs: string[] = [];
  const sessionIds: string[] = [];
  const storeIds: string[] = [];
  let app: FastifyInstance | undefined;
  let runtime: Awaited<ReturnType<typeof createPgLocalRuntime>> | undefined;
  const suffix = randomUUID().slice(0, 8);
  const username = `credential-${suffix}`;
  const casUsername = `credential-cas-${suffix}`;
  const initialPassword = "initial employee password 2038";
  const initialPin = "654321";
  const resetPassword = "replacement employee password 2038";
  const resetPin = "765432";

  try {
    await bootstrapLocalIdentity(
      { pool: adminPool, passwordPort: createPasswordPort() },
      {
        profile: LOCAL_PROFILE,
        adminUsername: fixture.adminUsername,
        adminDisplayName: fixture.adminDisplayName,
        adminPassword: fixture.adminPassword,
        adminPin: fixture.adminPin,
        approverUsername: fixture.approverUsername,
        approverDisplayName: fixture.approverDisplayName,
        approverPassword: fixture.approverPassword,
        approverPin: fixture.approverPin,
        demoOnly: false,
      },
    );
    runtime = await createPgLocalRuntime(urls.app, false, TEST_CONFIG, undefined, {});
    app = await createLocalApp({
      runtime,
      cookiePolicy: resolveCookiePolicy({ secure: false }),
      logger: false,
    });
    const admin = await login(
      app,
      fixture.adminUsername,
      fixture.adminPassword,
      "11111111-1111-4111-8111-111111111191",
    );
    const approver = await login(
      app,
      fixture.approverUsername,
      fixture.approverPassword,
      "11111111-1111-4111-8111-111111111192",
    );
    sessionIds.push(admin.sessionId, approver.sessionId);

    const created = await executeR5StaffCommand(
      app,
      admin,
      BOOTSTRAP_APPROVER_STAFF_ID,
      fixture.approverPin,
      "staff.create",
      {
        username,
        display_name: "Credential Lifecycle Staff",
        role: "staff",
        privacy_admin: false,
        reason: "real PostgreSQL credential lifecycle acceptance",
      },
    );
    targetIds.push(created.setup.target_staff_id);
    pendingRefs.push(created.confirmRef);
    const inactive = await adminPool.query<{
      is_active: boolean;
      role_active: boolean;
      password_hash: string;
      pin_hash: string | null;
    }>(
      `SELECT staff.is_active, role.is_active AS role_active, staff.password_hash, staff.pin_hash
         FROM staffs staff JOIN staff_store_roles role
           ON role.org_id = staff.org_id AND role.staff_id = staff.id
        WHERE staff.id = $1::uuid AND role.store_id = $2::uuid`,
      [created.setup.target_staff_id, LOCAL_PROFILE.storeId],
    );
    assert.deepEqual(inactive.rows[0], {
      is_active: false,
      role_active: false,
      password_hash: "!laundry-credential-pending",
      pin_hash: null,
    });

    const wrongCreator = await completeCredentials(
      app,
      approver,
      created.setup.credential_setup_ref,
      initialPassword,
      initialPin,
    );
    assert.equal(wrongCreator.statusCode, 400, wrongCreator.body);
    assert.equal(
      (wrongCreator.json() as { error?: { code?: string } }).error?.code,
      "RESOURCE_UNAVAILABLE",
    );
    const completed = await completeCredentials(
      app,
      admin,
      created.setup.credential_setup_ref,
      initialPassword,
      initialPin,
    );
    assert.equal(completed.statusCode, 200, completed.body);
    const initialActive = StaffCredentialsCompleteResponseSchema.parse(
      (completed.json() as { data: unknown }).data,
    );
    assert.equal(initialActive.permission_version, 2);

    const employee = await login(
      app,
      username,
      initialPassword,
      "11111111-1111-4111-8111-111111111193",
    );
    sessionIds.push(employee.sessionId);
    const secondaryStoreId = randomUUID();
    const secondarySessionId = randomUUID();
    const secondaryFamilyId = randomUUID();
    await adminPool.query(
      `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Credential Secondary Store', 'Asia/Shanghai', NOW(), NOW())`,
      [secondaryStoreId, LOCAL_PROFILE.orgId, `credential-secondary-${suffix}`],
    );
    storeIds.push(secondaryStoreId);
    await adminPool.query(
      `INSERT INTO sessions (
         id, org_id, store_id, staff_id, device_id, session_version, permission_version,
         authentication_method, status, created_at, last_seen_at
       ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,1,2,'password','active',NOW(),NOW())`,
      [
        secondarySessionId,
        LOCAL_PROFILE.orgId,
        secondaryStoreId,
        created.setup.target_staff_id,
        randomUUID(),
      ],
    );
    sessionIds.push(secondarySessionId);
    await adminPool.query(
      `INSERT INTO refresh_families (id, session_id, org_id, store_id, status, created_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'active',NOW())`,
      [secondaryFamilyId, secondarySessionId, LOCAL_PROFILE.orgId, secondaryStoreId],
    );
    await adminPool.query(
      `INSERT INTO refresh_tokens (
         id, family_id, session_id, org_id, store_id, token_hash, status, expires_at, created_at
       ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,'active',NOW() + interval '1 hour',NOW())`,
      [
        randomUUID(),
        secondaryFamilyId,
        secondarySessionId,
        LOCAL_PROFILE.orgId,
        secondaryStoreId,
        randomUUID(),
      ],
    );
    const expectRevocationDenied = async (
      context: TenantContext,
      parameters: readonly string[],
    ) => {
      await assert.rejects(
        () =>
          withPoolClient(runtime!.pool!, (sql) =>
            withTenantTransaction(sql, context, (tx) =>
              tx.query(
                "SELECT public.laundry_revoke_staff_sessions($1::uuid,$2::uuid,$3::uuid,$4::uuid)",
                parameters,
              ),
            ),
          ),
        (error: unknown) =>
          typeof error === "object" && error !== null && "code" in error && error.code === "42501",
      );
    };
    await expectRevocationDenied({ ...TENANT, staffId: created.setup.target_staff_id }, [
      LOCAL_PROFILE.orgId,
      LOCAL_PROFILE.storeId,
      created.setup.target_staff_id,
      created.setup.target_staff_id,
    ]);
    await expectRevocationDenied(TENANT, [
      randomUUID(),
      LOCAL_PROFILE.storeId,
      LOCAL_PROFILE.adminStaffId,
      created.setup.target_staff_id,
    ]);
    const reset = await executeR5StaffCommand(
      app,
      admin,
      BOOTSTRAP_APPROVER_STAFF_ID,
      fixture.approverPin,
      "staff.credentials.reset",
      {
        target_staff_id: created.setup.target_staff_id,
        expected_permission_version: initialActive.permission_version,
        reason: "real PostgreSQL credential reset acceptance",
      },
    );
    pendingRefs.push(reset.confirmRef);
    const revoked = await adminPool.query<{
      session_states: string[];
      family_states: string[];
      token_states: string[];
      permission_version: number;
    }>(
      `SELECT
         ARRAY(SELECT store_id::text || ':' || status FROM sessions
           WHERE staff_id = $1::uuid ORDER BY store_id) AS session_states,
         ARRAY(SELECT family.store_id::text || ':' || family.status
           FROM refresh_families family JOIN sessions session ON session.id = family.session_id
           WHERE session.staff_id = $1::uuid ORDER BY family.store_id) AS family_states,
         ARRAY(SELECT token.store_id::text || ':' || token.status
           FROM refresh_tokens token JOIN sessions session ON session.id = token.session_id
           WHERE session.staff_id = $1::uuid ORDER BY token.store_id) AS token_states,
         (SELECT permission_version FROM staffs WHERE id = $1::uuid) AS permission_version`,
      [created.setup.target_staff_id],
    );
    const expectedRevokedStates = [LOCAL_PROFILE.storeId, secondaryStoreId]
      .sort()
      .map((storeId) => `${storeId}:revoked`);
    assert.deepEqual(revoked.rows[0]?.session_states, expectedRevokedStates);
    assert.deepEqual(revoked.rows[0]?.family_states, expectedRevokedStates);
    assert.deepEqual(revoked.rows[0]?.token_states, expectedRevokedStates);
    assert.equal(revoked.rows[0]?.permission_version, 3);

    const staleBearer = await app.inject({
      method: "GET",
      url: "/api/v2/local/staff",
      headers: { ...BROWSER_HEADERS, authorization: `Bearer ${employee.accessToken}` },
    });
    assert.equal(staleBearer.statusCode, 401, staleBearer.body);
    const staleRefresh = await app.inject({
      method: "POST",
      url: "/api/v2/auth/refresh",
      headers: {
        ...BROWSER_HEADERS,
        cookie: employee.cookieHeader,
        [CSRF_HEADER_NAME]: employee.csrf,
      },
      payload: {},
    });
    assert.equal(staleRefresh.statusCode, 401, staleRefresh.body);
    await expectLoginRejected(
      app,
      username,
      initialPassword,
      "11111111-1111-4111-8111-111111111194",
    );

    await adminPool.query(
      `UPDATE staff_credential_setups
          SET created_at = NOW() - interval '20 minutes',
              expires_at = NOW() - interval '1 minute'
        WHERE id = $1::uuid`,
      [reset.setup.credential_setup_ref],
    );
    const expiredCompletion = await completeCredentials(
      app,
      admin,
      reset.setup.credential_setup_ref,
      resetPassword,
      resetPin,
    );
    assert.equal(expiredCompletion.statusCode, 400, expiredCompletion.body);
    assert.equal(
      (expiredCompletion.json() as { error?: { code?: string } }).error?.code,
      "RESOURCE_UNAVAILABLE",
    );
    const expired = await adminPool.query<{ status: string }>(
      "SELECT status FROM staff_credential_setups WHERE id = $1::uuid",
      [reset.setup.credential_setup_ref],
    );
    assert.equal(expired.rows[0]?.status, "expired");

    const reissued = await executeR5StaffCommand(
      app,
      approver,
      LOCAL_PROFILE.adminStaffId,
      fixture.adminPin,
      "staff.credentials.reset",
      {
        target_staff_id: created.setup.target_staff_id,
        expected_permission_version: 3,
        reason: "reissue expired credential setup from another approved administrator",
      },
    );
    pendingRefs.push(reissued.confirmRef);
    assert.notEqual(reissued.setup.credential_setup_ref, reset.setup.credential_setup_ref);
    const reissueWrongCreator = await completeCredentials(
      app,
      admin,
      reissued.setup.credential_setup_ref,
      resetPassword,
      resetPin,
    );
    assert.equal(reissueWrongCreator.statusCode, 400, reissueWrongCreator.body);
    const reissueCompleted = await completeCredentials(
      app,
      approver,
      reissued.setup.credential_setup_ref,
      resetPassword,
      resetPin,
    );
    assert.equal(reissueCompleted.statusCode, 200, reissueCompleted.body);
    assert.equal(
      StaffCredentialsCompleteResponseSchema.parse(
        (reissueCompleted.json() as { data: unknown }).data,
      ).permission_version,
      4,
    );
    const replay = await completeCredentials(
      app,
      approver,
      reissued.setup.credential_setup_ref,
      resetPassword,
      resetPin,
    );
    assert.equal(replay.statusCode, 400, replay.body);
    const replacementLogin = await login(
      app,
      username,
      resetPassword,
      "11111111-1111-4111-8111-111111111195",
    );
    sessionIds.push(replacementLogin.sessionId);

    const casCreated = await executeR5StaffCommand(
      app,
      admin,
      BOOTSTRAP_APPROVER_STAFF_ID,
      fixture.approverPin,
      "staff.create",
      {
        username: casUsername,
        display_name: "Credential CAS Staff",
        role: "staff",
        privacy_admin: false,
        reason: "real PostgreSQL CAS rejection acceptance",
      },
    );
    targetIds.push(casCreated.setup.target_staff_id);
    pendingRefs.push(casCreated.confirmRef);
    await adminPool.query(
      "UPDATE staffs SET permission_version = permission_version + 1 WHERE id = $1::uuid",
      [casCreated.setup.target_staff_id],
    );
    const casRejected = await completeCredentials(
      app,
      admin,
      casCreated.setup.credential_setup_ref,
      "cas employee password 2038",
      "876543",
    );
    assert.equal(casRejected.statusCode, 400, casRejected.body);
    const pendingAccess = await withPoolClient(runtime.pool!, (sql) =>
      withTenantTransaction(sql, TENANT, (tx) =>
        createSqlStaffAccessStore(tx, TENANT).set(LOCAL_PROFILE.adminStaffId, {
          target_staff_id: casCreated.setup.target_staff_id,
          expected_permission_version: 2,
          role: "admin",
          privacy_admin: true,
          is_active: true,
        }),
      ),
    );
    assert.deepEqual(pendingAccess, { ok: false, reason: "credential_pending" });

    const crossTenant = Object.freeze({
      orgId: "99999999-9999-4999-8999-999999999991",
      storeId: "99999999-9999-4999-8999-999999999992",
      staffId: "99999999-9999-4999-8999-999999999993",
    });
    const crossTenantResult = await withPoolClient(runtime.pool!, (sql) =>
      withTenantTransaction(sql, crossTenant, (tx) =>
        createSqlStaffCredentialStore(tx, crossTenant).complete(crossTenant.staffId, {
          credential_setup_ref: casCreated.setup.credential_setup_ref,
          password_hash: "unused-cross-tenant-password-hash",
          pin_hash: "unused-cross-tenant-pin-hash",
          now: Math.floor(Date.now() / 1_000),
          device_id: null,
        }),
      ),
    );
    assert.deepEqual(crossTenantResult, { ok: false });

    const adminVersion = await adminPool.query<{ permission_version: number }>(
      "SELECT permission_version FROM staffs WHERE id = $1::uuid",
      [LOCAL_PROFILE.adminStaffId],
    );
    const lastAdmin = await withPoolClient(runtime.pool!, async (sql) => {
      await sql.query("BEGIN");
      try {
        for (const statement of buildSetLocalGucStatements(TENANT)) {
          await sql.query(statement.sql, statement.values);
        }
        await sql.query(
          `UPDATE staff_store_roles SET is_active = false, is_privacy_admin = false
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND staff_id = $3::uuid`,
          [LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId, BOOTSTRAP_APPROVER_STAFF_ID],
        );
        await sql.query("UPDATE staffs SET is_active = false WHERE id = $1::uuid", [
          BOOTSTRAP_APPROVER_STAFF_ID,
        ]);
        return await createSqlStaffAccessStore(sql, TENANT).set(randomUUID(), {
          target_staff_id: LOCAL_PROFILE.adminStaffId,
          expected_permission_version: adminVersion.rows[0]?.permission_version ?? 0,
          role: "staff",
          privacy_admin: false,
          is_active: true,
        });
      } finally {
        await sql.query("ROLLBACK");
      }
    });
    assert.deepEqual(lastAdmin, { ok: false, reason: "last_admin" });

    const evidence = await adminPool.query<{
      command: string;
      before_json: string | null;
      after_json: string | null;
    }>(
      `SELECT command, before_json, after_json FROM audit_log
        WHERE entity_id = $1 ORDER BY at, id`,
      [created.setup.target_staff_id],
    );
    assert.ok(evidence.rows.some((row) => row.command === "staff.create"));
    assert.ok(evidence.rows.some((row) => row.command === "staff.credentials.reset"));
    assert.equal(
      evidence.rows.filter((row) => row.command === "staff.credentials.complete").length,
      2,
    );
    const persisted = await adminPool.query<{
      pending: unknown;
      idempotency: unknown;
      password_hash: string;
      pin_hash: string;
    }>(
      `SELECT
         (SELECT jsonb_agg(args_json) FROM ai_pending_actions
           WHERE nonce = ANY($1::uuid[])) AS pending,
         (SELECT jsonb_agg(result_json) FROM command_idempotency
           WHERE idempotency_key = ANY($1::uuid[])) AS idempotency,
         staff.password_hash,
         staff.pin_hash
       FROM staffs staff WHERE staff.id = $2::uuid`,
      [pendingRefs, created.setup.target_staff_id],
    );
    const hashes = persisted.rows[0];
    assert.ok(hashes);
    const secretFreeEvidence = JSON.stringify({
      audit: evidence.rows,
      pending: hashes.pending,
      idempotency: hashes.idempotency,
    });
    for (const forbidden of [initialPassword, initialPin, resetPassword, resetPin]) {
      assert.doesNotMatch(secretFreeEvidence, new RegExp(forbidden, "u"));
    }
    assert.equal(secretFreeEvidence.includes(hashes.password_hash), false);
    assert.equal(secretFreeEvidence.includes(hashes.pin_hash), false);
    const setupColumns = await adminPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'staff_credential_setups'`,
    );
    assert.doesNotMatch(
      setupColumns.rows.map((row) => row.column_name).join(" "),
      /password|pin|secret|hash/iu,
    );
  } finally {
    await app?.close();
    await runtime?.pool?.end();
    await cleanupEvidence(adminPool, targetIds, pendingRefs, sessionIds, storeIds);
    await adminPool.end();
  }
});
