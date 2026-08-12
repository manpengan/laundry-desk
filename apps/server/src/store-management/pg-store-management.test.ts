import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import test from "node:test";

import {
  AccessSessionResponseSchema,
  CSRF_HEADER_NAME,
  StoreAuthorizedListResultSchema,
} from "@laundry/contracts";

import { executeQuery } from "../bus/execute-query.js";
import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { createLocalApp } from "../http/create-app.js";
import { resolveCookiePolicy } from "../http/cookie-policy.js";
import { LOCAL_COOKIE_NAMES } from "../http/types.js";
import { createPasswordPort } from "../identity/password.js";
import { bootstrapLocalIdentity } from "../local/bootstrap.js";
import type { LocalServerConfig } from "../local/config.js";
import { createPgLocalRuntime } from "../local/create-runtime.js";
import { parsePgTestFixtureEnvironment } from "../local/pg-test-fixture.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { createPgStoreManagementDeps } from "./runtime.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;
const NOW = new Date("2097-08-11T03:04:05.000Z");
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
  accessTokenSecret: "owner-multistore-access-token-secret-32-bytes",
  csrfProofSecret: "owner-multistore-csrf-secret-independent-value",
});

type Fixture = Readonly<{
  orgId: string;
  staffId: string;
  currentStoreId: string;
  currentCode: string;
  otherStoreId: string;
  otherCode: string;
  hiddenStoreId: string;
  hiddenCode: string;
}>;

async function seedFixture(adminUrl: string): Promise<Fixture> {
  const pool = createPgPool({ connectionString: adminUrl });
  const client = await pool.connect();
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = Object.freeze({
    orgId: randomUUID(),
    staffId: randomUUID(),
    currentStoreId: randomUUID(),
    currentCode: `owner-current-${suffix}`,
    otherStoreId: randomUUID(),
    otherCode: `owner-other-${suffix}`,
    hiddenStoreId: randomUUID(),
    hiddenCode: `owner-hidden-${suffix}`,
  });
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    await client.query(
      `INSERT INTO orgs (id, code, name, created_at, updated_at)
       VALUES ($1::uuid, $2, 'Owner operations fixture', now(), now())`,
      [fixture.orgId, `owner-org-${suffix}`],
    );
    await client.query(
      `INSERT INTO staffs (
         id, org_id, username, password_hash, display_name, is_active,
         permission_version, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3, 'test-only-hash', 'Owner admin', true, 1, now(), now())`,
      [fixture.staffId, fixture.orgId, `owner-admin-${suffix}`],
    );
    for (const [storeId, code, name] of [
      [fixture.currentStoreId, fixture.currentCode, "Current Store"],
      [fixture.otherStoreId, fixture.otherCode, "Other Store"],
      [fixture.hiddenStoreId, fixture.hiddenCode, "Hidden Store"],
    ] as const) {
      await client.query(
        `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'Asia/Shanghai', now(), now())`,
        [storeId, fixture.orgId, code, name],
      );
      await client.query(
        `INSERT INTO staff_store_roles (
           id, org_id, store_id, staff_id, role, is_active, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'admin', $5, now(), now())`,
        [randomUUID(), fixture.orgId, storeId, fixture.staffId, storeId !== fixture.hiddenStoreId],
      );
    }
    await client.query("COMMIT");
    return fixture;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function cleanup(adminUrl: string, fixture: Fixture): Promise<void> {
  const pool = createPgPool({ connectionString: adminUrl });
  try {
    await pool.query("DELETE FROM audit_log WHERE org_id = $1::uuid", [fixture.orgId]);
    await pool.query("DELETE FROM staff_store_roles WHERE org_id = $1::uuid", [fixture.orgId]);
    await pool.query("DELETE FROM stores WHERE org_id = $1::uuid", [fixture.orgId]);
    await pool.query("DELETE FROM staffs WHERE org_id = $1::uuid", [fixture.orgId]);
    await pool.query("DELETE FROM customer_privacy_hmac_keys WHERE org_id = $1::uuid", [
      fixture.orgId,
    ]);
    await pool.query("DELETE FROM orgs WHERE id = $1::uuid", [fixture.orgId]);
  } finally {
    await pool.end();
  }
}

type LoginFixture = Readonly<{
  orgId: string;
  orgCode: string;
  staffId: string;
  username: string;
  password: string;
  displayName: string;
  approverStaffId: string;
  approverPin: string;
  workerStaffId: string;
  workerUsername: string;
  workerPassword: string;
  workerPin: string;
  currentStoreId: string;
  currentStoreCode: string;
  currentStoreName: string;
  otherStoreCode: string;
}>;

function responseCookies(
  headers: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
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

async function seedLoginFixture(adminUrl: string): Promise<LoginFixture> {
  const pool = createPgPool({ connectionString: adminUrl });
  const suffix = randomUUID().slice(0, 8);
  const password = `Owner secondary password ${suffix}`;
  const workerPassword = `Worker secondary password ${suffix}`;
  const passwordPort = createPasswordPort();
  const passwordHash = await passwordPort.hashPassword(password);
  const workerPasswordHash = await passwordPort.hashPassword(workerPassword);
  const approverPin = String(randomInt(100_000, 1_000_000));
  let workerPin = String(randomInt(100_000, 1_000_000));
  while (workerPin === approverPin) workerPin = String(randomInt(100_000, 1_000_000));
  const approverPinHash = await passwordPort.hashPassword(approverPin);
  const workerPinHash = await passwordPort.hashPassword(workerPin);
  const approverPasswordHash = await passwordPort.hashPassword(
    `Unused approver password ${suffix}`,
  );
  const fixture: LoginFixture = Object.freeze({
    orgId: randomUUID(),
    orgCode: `owner-login-org-${suffix}`,
    staffId: randomUUID(),
    username: `owner-login-${suffix}`,
    password,
    displayName: "Multi-store Owner",
    approverStaffId: randomUUID(),
    approverPin,
    workerStaffId: randomUUID(),
    workerUsername: `owner-worker-${suffix}`,
    workerPassword,
    workerPin,
    currentStoreId: randomUUID(),
    currentStoreCode: `owner-login-current-${suffix}`,
    currentStoreName: "Multi-store Current",
    otherStoreCode: `owner-login-other-${suffix}`,
  });
  try {
    await pool.query("BEGIN");
    await pool.query("SET LOCAL ROLE laundry_owner");
    await pool.query(
      `INSERT INTO orgs (id, code, name, created_at, updated_at)
       VALUES ($1::uuid, $2, 'Multi-store login fixture', now(), now())`,
      [fixture.orgId, fixture.orgCode],
    );
    await pool.query(
      `INSERT INTO staffs (
         id, org_id, username, password_hash, display_name, is_active,
         permission_version, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, true, 1, now(), now())`,
      [fixture.staffId, fixture.orgId, fixture.username, passwordHash, fixture.displayName],
    );
    await pool.query(
      `INSERT INTO staffs (
         id, org_id, username, password_hash, pin_hash, display_name, is_active,
         permission_version, created_at, updated_at
       ) VALUES
         ($1::uuid, $3::uuid, $4, $5, $6, 'Second Owner', true, 1, now(), now()),
         ($2::uuid, $3::uuid, $7, $8, $9, 'Store Worker', true, 1, now(), now())`,
      [
        fixture.approverStaffId,
        fixture.workerStaffId,
        fixture.orgId,
        `owner-approver-${suffix}`,
        approverPasswordHash,
        approverPinHash,
        fixture.workerUsername,
        workerPasswordHash,
        workerPinHash,
      ],
    );
    for (const [storeId, storeCode, storeName, timeZone] of [
      [fixture.currentStoreId, fixture.currentStoreCode, fixture.currentStoreName, "Asia/Tokyo"],
      [randomUUID(), fixture.otherStoreCode, "Multi-store Other", "Asia/Shanghai"],
    ] as const) {
      await pool.query(
        `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, now(), now())`,
        [storeId, fixture.orgId, storeCode, storeName, timeZone],
      );
      await pool.query(
        `INSERT INTO staff_store_roles (
           id, org_id, store_id, staff_id, role, is_privacy_admin, is_active,
           created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'admin', true, true, now(), now())`,
        [randomUUID(), fixture.orgId, storeId, fixture.staffId],
      );
    }
    for (const [staffId, role, privacyAdmin] of [
      [fixture.approverStaffId, "admin", true],
      [fixture.workerStaffId, "admin", false],
    ] as const) {
      await pool.query(
        `INSERT INTO staff_store_roles (
           id, org_id, store_id, staff_id, role, is_privacy_admin, is_active,
           created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, true, now(), now())`,
        [randomUUID(), fixture.orgId, fixture.currentStoreId, staffId, role, privacyAdmin],
      );
    }
    await pool.query("COMMIT");
    return fixture;
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  } finally {
    await pool.end();
  }
}

async function cleanupLoginFixture(adminUrl: string, fixture: LoginFixture): Promise<void> {
  const pool = createPgPool({ connectionString: adminUrl });
  try {
    await pool.query("DELETE FROM pin_lockouts WHERE org_id = $1::uuid", [fixture.orgId]);
    await pool.query("DELETE FROM pin_challenges WHERE org_id = $1::uuid", [fixture.orgId]);
    await pool.query("DELETE FROM step_up_proofs WHERE org_id = $1::uuid", [fixture.orgId]);
    await pool.query("DELETE FROM ai_pending_actions WHERE org_id = $1::uuid", [fixture.orgId]);
    await pool.query("DELETE FROM staff_credential_setups WHERE org_id = $1::uuid", [
      fixture.orgId,
    ]);
    await pool.query("DELETE FROM refresh_tokens WHERE org_id = $1::uuid", [fixture.orgId]);
    await pool.query(
      `DELETE FROM refresh_families
        WHERE session_id IN (SELECT id FROM sessions WHERE org_id = $1::uuid)`,
      [fixture.orgId],
    );
    await pool.query("DELETE FROM sessions WHERE org_id = $1::uuid", [fixture.orgId]);
    await pool.query("DELETE FROM command_idempotency WHERE org_id = $1::uuid", [fixture.orgId]);
    await pool.query("DELETE FROM audit_log WHERE org_id = $1::uuid", [fixture.orgId]);
    await pool.query("DELETE FROM staff_store_roles WHERE org_id = $1::uuid", [fixture.orgId]);
    await pool.query("DELETE FROM stores WHERE org_id = $1::uuid", [fixture.orgId]);
    await pool.query("DELETE FROM staffs WHERE org_id = $1::uuid", [fixture.orgId]);
    await pool.query("DELETE FROM customer_privacy_hmac_keys WHERE org_id = $1::uuid", [
      fixture.orgId,
    ]);
    await pool.query("DELETE FROM orgs WHERE id = $1::uuid", [fixture.orgId]);
  } finally {
    await pool.end();
  }
}

maybe("real PG owner store list reauthorizes and rename is CAS-audited", async () => {
  assert.ok(urls);
  const fixture = await seedFixture(urls.admin);
  const appPool = createPgPool({ connectionString: urls.app });
  const tenant: TenantContext = Object.freeze({
    orgId: fixture.orgId,
    storeId: fixture.currentStoreId,
    staffId: fixture.staffId,
  });
  const actor: ActorContext = Object.freeze({
    staffId: fixture.staffId,
    deviceId: null,
    via: "ui",
    permissions: Object.freeze(["store_manage"]),
  });
  try {
    const storeManagement = Object.freeze({
      ...createPgStoreManagementDeps(),
      now: () => NOW,
    });
    const { registry, queryRegistry, chainHooks } = createRegisteredM1Bus({ storeManagement });
    const persistenceHooks = Object.freeze({
      ...chainHooks,
      checkPolicy: async () =>
        Object.freeze({ ok: true as const, data: Object.freeze({ allowed: true as const }) }),
    });

    const listed = await withPoolClient(appPool, (client) =>
      executeQuery(client, tenant, "store.authorized.list", {}, { registry: queryRegistry, actor }),
    );
    assert.equal(listed.ok, true, JSON.stringify(listed));
    if (!listed.ok) return;
    const directory = listed.data.result as {
      returned_store_count: number;
      stores: readonly Readonly<Record<string, unknown>>[];
    };
    assert.equal(directory.returned_store_count, 2);
    assert.deepEqual(
      directory.stores.map((store) => store.store_code),
      [fixture.currentCode, fixture.otherCode].sort(),
    );
    assert.equal(
      directory.stores.some(
        (store) =>
          store.store_code === fixture.hiddenCode || "store_id" in store || "org_id" in store,
      ),
      false,
    );

    const renamed = await withPoolClient(appPool, (client) =>
      executeCommand(
        client,
        tenant,
        "store.profile.set",
        {
          expected_profile_version: 1,
          store_name: "Renamed Current Store",
          reason: "real PostgreSQL owner operations acceptance",
        },
        { registry, actor, chainHooks: persistenceHooks },
      ),
    );
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    if (!renamed.ok) return;
    assert.deepEqual(renamed.data.result, {
      store: {
        store_code: fixture.currentCode,
        store_name: "Renamed Current Store",
        timezone: "Asia/Shanghai",
        profile_version: 2,
        updated_at: NOW.toISOString(),
        is_current: true,
      },
    });

    const stale = await withPoolClient(appPool, (client) =>
      executeCommand(
        client,
        tenant,
        "store.profile.set",
        {
          expected_profile_version: 1,
          store_name: "Must Not Win",
          reason: "stale CAS acceptance",
        },
        { registry, actor, chainHooks: persistenceHooks },
      ),
    );
    assert.equal(stale.ok, false, JSON.stringify(stale));
    if (!stale.ok) assert.equal(stale.error.code, "IDEMPOTENCY_CONFLICT");

    const persisted = await withPoolClient(appPool, (client) =>
      withTenantTransaction(client, tenant, (sql) =>
        sql.query<{
          name: string;
          profile_version: number;
          audits: string;
        }>(
          `SELECT store.name, store.profile_version,
                  (SELECT count(*)::text FROM audit_log
                    WHERE org_id = $1::uuid AND store_id = $2::uuid
                      AND command = 'store.profile.set' AND entity = 'store_profile') AS audits
             FROM stores AS store
            WHERE store.org_id = $1::uuid AND store.id = $2::uuid`,
          [fixture.orgId, fixture.currentStoreId],
        ),
      ),
    );
    assert.deepEqual(persisted.rows[0], {
      name: "Renamed Current Store",
      profile_version: 2,
      audits: "1",
    });
  } finally {
    await appPool.end();
    await cleanup(urls.admin, fixture);
  }
});

maybe(
  "real PG login, refresh and staff directory support a non-bootstrap owner store",
  async () => {
    assert.ok(urls);
    const bootstrap = parsePgTestFixtureEnvironment(process.env);
    const adminPool = createPgPool({ connectionString: urls.admin });
    let fixture: LoginFixture | undefined;
    let runtime: Awaited<ReturnType<typeof createPgLocalRuntime>> | undefined;
    let app: Awaited<ReturnType<typeof createLocalApp>> | undefined;
    try {
      await bootstrapLocalIdentity(
        { pool: adminPool, passwordPort: createPasswordPort() },
        {
          profile: LOCAL_PROFILE,
          adminUsername: bootstrap.adminUsername,
          adminDisplayName: bootstrap.adminDisplayName,
          adminPassword: bootstrap.adminPassword,
          adminPin: bootstrap.adminPin,
          approverUsername: bootstrap.approverUsername,
          approverDisplayName: bootstrap.approverDisplayName,
          approverPassword: bootstrap.approverPassword,
          approverPin: bootstrap.approverPin,
          demoOnly: false,
        },
      );
      fixture = await seedLoginFixture(urls.admin);
      runtime = await createPgLocalRuntime(urls.app, false, TEST_CONFIG, undefined, {});
      app = await createLocalApp({
        runtime,
        cookiePolicy: resolveCookiePolicy({ secure: false }),
        logger: false,
      });

      const initialWorkerLogin = await app.inject({
        method: "POST",
        url: "/api/v2/auth/login",
        headers: BROWSER_HEADERS,
        payload: {
          org_code: fixture.orgCode,
          store_code: fixture.currentStoreCode,
          username: fixture.workerUsername,
          password: fixture.workerPassword,
          device_id: randomUUID(),
        },
      });
      assert.equal(initialWorkerLogin.statusCode, 200, initialWorkerLogin.body);
      const workerAccess = AccessSessionResponseSchema.parse(
        (initialWorkerLogin.json() as Readonly<{ data: unknown }>).data,
      );
      const workerCookies = responseCookies(
        initialWorkerLogin.headers as Readonly<Record<string, unknown>>,
      );
      await adminPool.query(
        `UPDATE staff_store_roles
            SET role = 'staff', updated_at = now()
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND staff_id = $3::uuid`,
        [fixture.orgId, fixture.currentStoreId, fixture.workerStaffId],
      );
      const staleWorkerBearer = await app.inject({
        method: "GET",
        url: "/api/v2/local/staff",
        headers: {
          ...BROWSER_HEADERS,
          authorization: `Bearer ${workerAccess.access_token}`,
        },
      });
      assert.equal(staleWorkerBearer.statusCode, 401, staleWorkerBearer.body);
      const staleWorkerRefresh = await app.inject({
        method: "POST",
        url: "/api/v2/auth/refresh",
        headers: {
          ...BROWSER_HEADERS,
          cookie: Object.entries(workerCookies)
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
          [CSRF_HEADER_NAME]: workerCookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
        },
        payload: {},
      });
      assert.equal(staleWorkerRefresh.statusCode, 401, staleWorkerRefresh.body);

      const staffLogin = await app.inject({
        method: "POST",
        url: "/api/v2/auth/login",
        headers: BROWSER_HEADERS,
        payload: {
          org_code: fixture.orgCode,
          store_code: fixture.currentStoreCode,
          username: fixture.workerUsername,
          password: fixture.workerPassword,
          device_id: randomUUID(),
        },
      });
      assert.equal(staffLogin.statusCode, 401, staffLogin.body);
      assert.deepEqual(
        responseCookies(staffLogin.headers as Readonly<Record<string, unknown>>),
        {},
      );

      const login = await app.inject({
        method: "POST",
        url: "/api/v2/auth/login",
        headers: BROWSER_HEADERS,
        payload: {
          org_code: fixture.orgCode,
          store_code: fixture.currentStoreCode,
          username: fixture.username,
          password: fixture.password,
          device_id: randomUUID(),
        },
      });
      assert.equal(login.statusCode, 200, login.body);
      const access = AccessSessionResponseSchema.parse(
        (login.json() as Readonly<{ data: unknown }>).data,
      );
      assert.deepEqual(access.display, {
        store_name: fixture.currentStoreName,
        staff_name: fixture.displayName,
        org_code: fixture.orgCode,
        store_code: fixture.currentStoreCode,
      });
      assert.equal(access.session.org_id, fixture.orgId);
      assert.equal(access.session.store_id, fixture.currentStoreId);
      assert.equal(access.session.staff_id, fixture.staffId);

      const initialCookies = responseCookies(login.headers as Readonly<Record<string, unknown>>);
      const initialCookieHeader = Object.entries(initialCookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
      const authenticatedHeaders = Object.freeze({
        ...BROWSER_HEADERS,
        authorization: `Bearer ${access.access_token}`,
      });
      const mutationHeaders = Object.freeze({
        ...authenticatedHeaders,
        cookie: initialCookieHeader,
        [CSRF_HEADER_NAME]: initialCookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
      });
      const directory = await app.inject({
        method: "GET",
        url: "/api/v2/local/staff",
        headers: authenticatedHeaders,
      });
      assert.equal(directory.statusCode, 200, directory.body);
      assert.equal(directory.headers["cache-control"], "no-store");
      assert.deepEqual((directory.json() as Readonly<{ data: unknown }>).data, [
        {
          staff_id: fixture.approverStaffId,
          display_name: "Second Owner",
          role: "admin",
          username: `owner-approver-${fixture.username.slice(-8)}`,
          privacy_admin: true,
        },
        {
          staff_id: fixture.staffId,
          display_name: fixture.displayName,
          role: "admin",
          username: fixture.username,
          privacy_admin: true,
        },
        {
          staff_id: fixture.workerStaffId,
          display_name: "Store Worker",
          role: "staff",
          username: fixture.workerUsername,
          privacy_admin: false,
        },
      ]);

      const blockedCounterQuery = await app.inject({
        method: "POST",
        url: "/v1/queries/catalog.items.list",
        headers: authenticatedHeaders,
        payload: {},
      });
      assert.equal(blockedCounterQuery.statusCode, 404, blockedCounterQuery.body);
      assert.equal(
        (blockedCounterQuery.json() as Readonly<{ error: Readonly<{ code: string }> }>).error.code,
        "RESOURCE_UNAVAILABLE",
      );

      const quickSwitch = await app.inject({
        method: "POST",
        url: "/api/v2/auth/pin/challenges",
        headers: mutationHeaders,
        payload: { purpose: "quick_switch", target_staff_id: fixture.workerStaffId },
      });
      assert.equal(quickSwitch.statusCode, 200, quickSwitch.body);
      const quickSwitchId = (
        quickSwitch.json() as Readonly<{ data: Readonly<{ challenge_id: string }> }>
      ).data.challenge_id;
      const deniedSwitch = await app.inject({
        method: "POST",
        url: `/api/v2/auth/pin/challenges/${quickSwitchId}/verify`,
        headers: mutationHeaders,
        payload: { challenge_id: quickSwitchId, pin: fixture.workerPin },
      });
      assert.equal(deniedSwitch.statusCode, 401, deniedSwitch.body);
      assert.deepEqual(
        responseCookies(deniedSwitch.headers as Readonly<Record<string, unknown>>),
        {},
      );

      const stores = await app.inject({
        method: "POST",
        url: "/v1/queries/store.authorized.list",
        headers: authenticatedHeaders,
        payload: {},
      });
      assert.equal(stores.statusCode, 200, stores.body);
      const storeResult = StoreAuthorizedListResultSchema.parse(
        (stores.json() as Readonly<{ data: Readonly<{ result: unknown }> }>).data.result,
      );
      assert.deepEqual(
        storeResult.stores.map((store) => store.store_code),
        [fixture.currentStoreCode, fixture.otherStoreCode].sort(),
      );
      assert.equal(
        storeResult.stores.find((store) => store.is_current)?.store_code,
        fixture.currentStoreCode,
      );

      const gatedRename = await app.inject({
        method: "POST",
        url: "/v1/commands/store.profile.set",
        headers: mutationHeaders,
        payload: {
          expected_profile_version: 1,
          store_name: "Multi-store Renamed",
          reason: "real PostgreSQL non-bootstrap R5 acceptance",
        },
      });
      assert.equal(gatedRename.statusCode, 403, gatedRename.body);
      const confirmRef = (
        gatedRename.json() as Readonly<{
          error: Readonly<{ detail: Readonly<{ confirm_ref: string }> }>;
        }>
      ).error.detail.confirm_ref;
      const stepUp = await app.inject({
        method: "POST",
        url: "/api/v2/auth/pin/challenges",
        headers: mutationHeaders,
        payload: {
          purpose: "step_up",
          pending_action_ref: confirmRef,
          approver_staff_id: fixture.approverStaffId,
        },
      });
      assert.equal(stepUp.statusCode, 200, stepUp.body);
      const stepUpId = (stepUp.json() as Readonly<{ data: Readonly<{ challenge_id: string }> }>)
        .data.challenge_id;
      const approved = await app.inject({
        method: "POST",
        url: `/api/v2/auth/pin/challenges/${stepUpId}/verify`,
        headers: mutationHeaders,
        payload: { challenge_id: stepUpId, pin: fixture.approverPin },
      });
      assert.equal(approved.statusCode, 200, approved.body);
      const renamed = await app.inject({
        method: "POST",
        url: "/v1/commands/store.profile.set",
        headers: mutationHeaders,
        payload: { confirm_ref: confirmRef },
      });
      assert.equal(renamed.statusCode, 200, renamed.body);
      assert.equal(
        (
          renamed.json() as Readonly<{
            data: Readonly<{ result: Readonly<{ store: Readonly<{ profile_version: number }> }> }>;
          }>
        ).data.result.store.profile_version,
        2,
      );

      const refresh = await app.inject({
        method: "POST",
        url: "/api/v2/auth/refresh",
        headers: {
          ...BROWSER_HEADERS,
          cookie: initialCookieHeader,
          [CSRF_HEADER_NAME]: initialCookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
        },
        payload: {},
      });
      assert.equal(refresh.statusCode, 200, refresh.body);
      const refreshed = AccessSessionResponseSchema.parse(
        (refresh.json() as Readonly<{ data: unknown }>).data,
      );
      assert.equal(refreshed.session.session_id, access.session.session_id);
      assert.equal(refreshed.session.store_id, fixture.currentStoreId);
      assert.deepEqual(refreshed.display, { ...access.display, store_name: "Multi-store Renamed" });

      const rotatedCookies = responseCookies(refresh.headers as Readonly<Record<string, unknown>>);
      const logout = await app.inject({
        method: "POST",
        url: "/api/v2/auth/logout",
        headers: {
          ...BROWSER_HEADERS,
          authorization: `Bearer ${refreshed.access_token}`,
          cookie: Object.entries(rotatedCookies)
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
          [CSRF_HEADER_NAME]: rotatedCookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
        },
        payload: {},
      });
      assert.equal(logout.statusCode, 200, logout.body);
    } finally {
      await app?.close();
      await runtime?.pool?.end();
      if (fixture !== undefined) await cleanupLoginFixture(urls.admin, fixture);
      await adminPool.end();
    }
  },
);
