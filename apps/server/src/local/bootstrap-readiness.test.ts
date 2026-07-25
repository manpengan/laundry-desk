import assert from "node:assert/strict";
import test from "node:test";

import { createPgPool, resolvePgUrls, type PgPool, type PgPoolClient } from "../db/pg-pool.js";
import { BOOTSTRAP_ADMIN_ROLE_ID, assertLocalBootstrapReady } from "./bootstrap.js";
import { LOCAL_PROFILE } from "./profile.js";

const realPgUrls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybeRealPg = realPgUrls === null ? test.skip : test;

type QueryRecord = Readonly<{
  sql: string;
  params: readonly unknown[] | undefined;
}>;

function createReadinessPool(
  row: ReturnType<typeof readyProfileRow> | undefined,
  explicitBootstrapReady = true,
): Readonly<{ pool: PgPool; queries: QueryRecord[]; released: () => boolean }> {
  const queries: QueryRecord[] = [];
  let didRelease = false;
  const client = {
    async query(
      sql: string,
      params?: readonly unknown[],
    ): Promise<{ rows: readonly unknown[]; rowCount: number }> {
      queries.push(Object.freeze({ sql, params }));
      if (sql.includes("current_user")) {
        return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
      }
      if (sql.includes("laundry_local_bootstrap_ready")) {
        return {
          rows: [{ explicit_bootstrap_ready: explicitBootstrapReady }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release(): void {
      didRelease = true;
    },
  } as unknown as PgPoolClient;
  return Object.freeze({
    pool: { connect: async () => client } as unknown as PgPool,
    queries,
    released: () => didRelease,
  });
}

function readyProfileRow(
  overrides: Partial<
    Readonly<{
      authenticated_role: string;
      authenticated_role_has_memberships: boolean;
      authenticated_role_can_login: boolean;
      authenticated_role_inherits: boolean;
      authenticated_role_can_create_db: boolean;
      authenticated_role_can_create_role: boolean;
      authenticated_role_can_replicate: boolean;
      authenticated_role_owns_database: boolean;
      authenticated_role_owns_public_schema: boolean;
      authenticated_role_owns_public_objects: boolean;
      authenticated_role_can_create_database_objects: boolean;
      authenticated_role_can_create_temporary_objects: boolean;
      authenticated_role_can_create_public_objects: boolean;
      effective_search_path: readonly string[];
      current_role: string;
      current_role_is_superuser: boolean;
      current_role_bypasses_rls: boolean;
      org_demo_only: boolean;
    }>
  > = {},
) {
  return Object.freeze({
    authenticated_role: "laundry_app",
    authenticated_role_has_memberships: false,
    authenticated_role_can_login: true,
    authenticated_role_inherits: false,
    authenticated_role_can_create_db: false,
    authenticated_role_can_create_role: false,
    authenticated_role_can_replicate: false,
    authenticated_role_owns_database: false,
    authenticated_role_owns_public_schema: false,
    authenticated_role_owns_public_objects: false,
    authenticated_role_can_create_database_objects: false,
    authenticated_role_can_create_temporary_objects: false,
    authenticated_role_can_create_public_objects: false,
    effective_search_path: ["public"],
    current_role: "laundry_app",
    current_role_is_superuser: false,
    current_role_bypasses_rls: false,
    org_demo_only: false,
    org_id: LOCAL_PROFILE.orgId,
    org_code: LOCAL_PROFILE.orgCode,
    org_name: LOCAL_PROFILE.orgName,
    store_id: LOCAL_PROFILE.storeId,
    store_code: LOCAL_PROFILE.storeCode,
    store_name: LOCAL_PROFILE.storeName,
    store_timezone: LOCAL_PROFILE.timezone,
    admin_staff_id: LOCAL_PROFILE.adminStaffId,
    admin_username: "admin",
    admin_display_name: "Local Administrator",
    admin_is_active: true,
    role_id: BOOTSTRAP_ADMIN_ROLE_ID,
    role_name: "admin",
    role_is_active: true,
    ...overrides,
  });
}

test("app-role readiness verifies the complete fixed local profile", async () => {
  const database = createReadinessPool(readyProfileRow());

  await assertLocalBootstrapReady(database.pool);

  assert.equal(database.released(), true);
  assert.ok(database.queries.some((query) => query.sql.includes("app.org_id")));
  assert.ok(database.queries.some((query) => query.sql.includes("app.store_id")));
  const profileQuery = database.queries.find((query) => query.sql.includes("current_user"));
  assert.ok(profileQuery);
  assert.match(profileQuery.sql, /pg_catalog\.pg_has_role\([^)]*, 'MEMBER'\)/u);
  assert.match(
    profileQuery.sql,
    /pg_catalog\.has_database_privilege\(\s*session_user,\s*pg_catalog\.current_database\(\),\s*'TEMPORARY'\s*\)/u,
  );
  assert.match(profileQuery.sql, /pg_catalog\.current_schemas\(false\)::text\[\]/u);
  assert.doesNotMatch(profileQuery.sql, /granted_role\.rolsuper/u);
  const markerQuery = database.queries.find((query) =>
    query.sql.includes("laundry_local_bootstrap_ready"),
  );
  assert.deepEqual(markerQuery?.params?.slice(0, 3), [
    LOCAL_PROFILE.orgId,
    LOCAL_PROFILE.storeId,
    LOCAL_PROFILE.adminStaffId,
  ]);
  assert.match(String(markerQuery?.params?.[3]), /^[0-9a-f]{64}$/u);
  assert.equal(markerQuery?.params?.[4], false);
  assert.equal(database.queries.at(-1)?.sql, "COMMIT");
});

test("app-role readiness accepts demo data only in the explicit demo runtime", async () => {
  const database = createReadinessPool(readyProfileRow({ org_demo_only: true }));

  await assertLocalBootstrapReady(database.pool, true);

  assert.equal(database.queries.at(-1)?.sql, "COMMIT");
  assert.equal(database.released(), true);
});

test("app-role readiness rejects admin connections and missing bootstrap state", async (t) => {
  await t.test("admin connection", async () => {
    const database = createReadinessPool(readyProfileRow({ current_role: "postgres" }));
    await assert.rejects(
      () => assertLocalBootstrapReady(database.pool),
      /LOCAL_RUNTIME_NOT_READY/u,
    );
    assert.equal(database.queries.at(-1)?.sql, "ROLLBACK");
    assert.equal(database.released(), true);
  });

  await t.test("missing profile", async () => {
    const database = createReadinessPool(undefined);
    await assert.rejects(
      () => assertLocalBootstrapReady(database.pool),
      /LOCAL_RUNTIME_NOT_READY/u,
    );
    assert.equal(database.queries.at(-1)?.sql, "ROLLBACK");
    assert.equal(database.released(), true);
  });

  for (const [name, overrides] of [
    ["admin authentication with SET ROLE", { authenticated_role: "postgres" }],
    ["app role with any other membership", { authenticated_role_has_memberships: true }],
    ["app role without LOGIN", { authenticated_role_can_login: false }],
    ["app role with INHERIT", { authenticated_role_inherits: true }],
    ["app role with CREATEDB", { authenticated_role_can_create_db: true }],
    ["app role with CREATEROLE", { authenticated_role_can_create_role: true }],
    ["app role with REPLICATION", { authenticated_role_can_replicate: true }],
    ["app role owning the database", { authenticated_role_owns_database: true }],
    ["app role owning the public schema", { authenticated_role_owns_public_schema: true }],
    ["app role owning public objects", { authenticated_role_owns_public_objects: true }],
    ["app role with database CREATE", { authenticated_role_can_create_database_objects: true }],
    ["app role with database TEMPORARY", { authenticated_role_can_create_temporary_objects: true }],
    ["app role with public schema CREATE", { authenticated_role_can_create_public_objects: true }],
    ["unsafe effective search path", { effective_search_path: ["laundry_app", "public"] }],
    ["demo database in non-demo runtime", { org_demo_only: true }],
    ["superuser app role", { current_role_is_superuser: true }],
    ["BYPASSRLS app role", { current_role_bypasses_rls: true }],
  ] as const) {
    await t.test(name, async () => {
      const database = createReadinessPool(readyProfileRow(overrides));
      await assert.rejects(
        () => assertLocalBootstrapReady(database.pool),
        /LOCAL_RUNTIME_NOT_READY/u,
      );
      assert.equal(database.queries.at(-1)?.sql, "ROLLBACK");
      assert.equal(database.released(), true);
    });
  }

  await t.test("missing explicit bootstrap marker", async () => {
    const database = createReadinessPool(readyProfileRow(), false);
    await assert.rejects(
      () => assertLocalBootstrapReady(database.pool),
      /LOCAL_RUNTIME_NOT_READY/u,
    );
    assert.equal(database.queries.at(-1)?.sql, "ROLLBACK");
    assert.equal(database.released(), true);
  });
});

maybeRealPg("real PG readiness rejects an admin login that SET ROLEs to laundry_app", async () => {
  assert.ok(realPgUrls);
  const expectedDemoOnly = process.env.LAUNDRY_LOCAL_DEMO === "1";
  const adminPool = createPgPool({ connectionString: realPgUrls.admin, max: 1 });
  const appPool = createPgPool({ connectionString: realPgUrls.app, max: 1 });
  const attackUrl = new URL(realPgUrls.admin);
  attackUrl.searchParams.set("options", "-c role=laundry_app");
  const adminAsAppPool = createPgPool({ connectionString: attackUrl.toString(), max: 1 });
  let ownerMembershipGranted = false;
  let predefinedMembershipGranted = false;
  let unsafeSearchPathPool: PgPool | undefined;
  let shadowSchemaCreated = false;
  let deletedMetadata:
    | Readonly<{
        singleton: boolean;
        org_id: string;
        store_id: string;
        admin_staff_id: string;
        profile_hash: string;
        demo_only: boolean;
        created_at: Date;
      }>
    | undefined;

  try {
    const temporaryPrivilege = await appPool.query<{ can_create_temporary: boolean }>(
      `SELECT pg_catalog.has_database_privilege(
         session_user,
         pg_catalog.current_database(),
         'TEMPORARY'
       ) AS can_create_temporary`,
    );
    assert.equal(temporaryPrivilege.rows[0]?.can_create_temporary, false);
    await assert.rejects(
      () => appPool.query("CREATE TEMPORARY TABLE forbidden_runtime_temp (id integer)"),
      /permission denied.*temporary.*database/iu,
    );

    const expectedDefinerFunctions = [
      "laundry_auth_find_org_store",
      "laundry_auth_lookup_family",
      "laundry_auth_lookup_pin",
      "laundry_auth_lookup_refresh_by_hash",
      "laundry_auth_lookup_refresh_by_id",
      "laundry_auth_lookup_session",
      "laundry_local_bootstrap_ready",
    ];
    const hardenedFunctions = await adminPool.query<{
      function_name: string;
      function_config: string[] | null;
    }>(
      `SELECT proc.proname AS function_name,
              proc.proconfig::text[] AS function_config
       FROM pg_catalog.pg_proc proc
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = proc.pronamespace
       WHERE namespace.nspname = 'public'
         AND proc.proname = ANY($1::text[])
       ORDER BY proc.proname`,
      [expectedDefinerFunctions],
    );
    assert.deepEqual(
      hardenedFunctions.rows.map((row) => row.function_name),
      expectedDefinerFunctions,
    );
    assert.ok(
      hardenedFunctions.rows.every((row) =>
        row.function_config?.includes("search_path=pg_catalog, pg_temp"),
      ),
    );

    await assertLocalBootstrapReady(appPool, expectedDemoOnly);
    await assert.rejects(
      () => assertLocalBootstrapReady(appPool, !expectedDemoOnly),
      /LOCAL_RUNTIME_NOT_READY/u,
    );

    const identity = await adminAsAppPool.query<{
      authenticated_role: string;
      current_role: string;
    }>("SELECT session_user AS authenticated_role, current_user AS current_role");
    assert.deepEqual(identity.rows[0], {
      authenticated_role: "postgres",
      current_role: "laundry_app",
    });
    await assert.rejects(
      () => assertLocalBootstrapReady(adminAsAppPool, expectedDemoOnly),
      /LOCAL_RUNTIME_NOT_READY/u,
    );

    await adminPool.query("GRANT laundry_owner TO laundry_app");
    ownerMembershipGranted = true;
    await assert.rejects(
      () => assertLocalBootstrapReady(appPool, expectedDemoOnly),
      /LOCAL_RUNTIME_NOT_READY/u,
    );
    await adminPool.query("REVOKE laundry_owner FROM laundry_app");
    ownerMembershipGranted = false;
    await assertLocalBootstrapReady(appPool, expectedDemoOnly);

    await adminPool.query("GRANT laundry_owner TO laundry_app WITH INHERIT TRUE, SET FALSE");
    ownerMembershipGranted = true;
    const inheritedMembership = await appPool.query<{
      can_set_owner: boolean;
      can_use_owner: boolean;
    }>(
      `SELECT pg_has_role(session_user, 'laundry_owner', 'SET') AS can_set_owner,
              pg_has_role(session_user, 'laundry_owner', 'USAGE') AS can_use_owner`,
    );
    assert.deepEqual(inheritedMembership.rows[0], {
      can_set_owner: false,
      can_use_owner: true,
    });
    await assert.rejects(
      () => assertLocalBootstrapReady(appPool, expectedDemoOnly),
      /LOCAL_RUNTIME_NOT_READY/u,
    );
    await adminPool.query("REVOKE laundry_owner FROM laundry_app");
    ownerMembershipGranted = false;
    await assertLocalBootstrapReady(appPool, expectedDemoOnly);

    await adminPool.query(
      "GRANT laundry_owner TO laundry_app WITH ADMIN TRUE, INHERIT FALSE, SET FALSE",
    );
    ownerMembershipGranted = true;
    const adminOnlyMembership = await appPool.query<{
      is_member: boolean;
      can_set_owner: boolean;
      can_use_owner: boolean;
    }>(
      `SELECT pg_has_role(session_user, 'laundry_owner', 'MEMBER') AS is_member,
              pg_has_role(session_user, 'laundry_owner', 'SET') AS can_set_owner,
              pg_has_role(session_user, 'laundry_owner', 'USAGE') AS can_use_owner`,
    );
    assert.deepEqual(adminOnlyMembership.rows[0], {
      is_member: true,
      can_set_owner: false,
      can_use_owner: false,
    });
    await assert.rejects(
      () => assertLocalBootstrapReady(appPool, expectedDemoOnly),
      /LOCAL_RUNTIME_NOT_READY/u,
    );
    await adminPool.query("REVOKE laundry_owner FROM laundry_app");
    ownerMembershipGranted = false;
    await assertLocalBootstrapReady(appPool, expectedDemoOnly);

    await adminPool.query("GRANT pg_write_all_data TO laundry_app WITH INHERIT TRUE, SET FALSE");
    predefinedMembershipGranted = true;
    const predefinedMembership = await appPool.query<{
      can_set_role: boolean;
      can_use_role: boolean;
    }>(
      `SELECT pg_has_role(session_user, 'pg_write_all_data', 'SET') AS can_set_role,
              pg_has_role(session_user, 'pg_write_all_data', 'USAGE') AS can_use_role`,
    );
    assert.deepEqual(predefinedMembership.rows[0], {
      can_set_role: false,
      can_use_role: true,
    });
    await assert.rejects(
      () => assertLocalBootstrapReady(appPool, expectedDemoOnly),
      /LOCAL_RUNTIME_NOT_READY/u,
    );
    await adminPool.query("REVOKE pg_write_all_data FROM laundry_app");
    predefinedMembershipGranted = false;
    await assertLocalBootstrapReady(appPool, expectedDemoOnly);

    await adminPool.query("CREATE SCHEMA runtime_shadow_probe AUTHORIZATION laundry_app");
    shadowSchemaCreated = true;
    const unsafeSearchPathUrl = new URL(realPgUrls.app);
    unsafeSearchPathUrl.searchParams.set("options", "-c search_path=runtime_shadow_probe,public");
    const shadowPool = createPgPool({
      connectionString: unsafeSearchPathUrl.toString(),
      max: 1,
    });
    unsafeSearchPathPool = shadowPool;
    const effectivePath = await shadowPool.query<{
      effective_search_path: string[];
    }>("SELECT pg_catalog.current_schemas(false)::text[] AS effective_search_path");
    assert.deepEqual(effectivePath.rows[0]?.effective_search_path, [
      "runtime_shadow_probe",
      "public",
    ]);
    await assert.rejects(
      () => assertLocalBootstrapReady(shadowPool, expectedDemoOnly),
      /LOCAL_RUNTIME_NOT_READY/u,
    );
    await shadowPool.end();
    unsafeSearchPathPool = undefined;
    await adminPool.query("DROP SCHEMA runtime_shadow_probe");
    shadowSchemaCreated = false;
    await assertLocalBootstrapReady(appPool, expectedDemoOnly);

    const removed = await adminPool.query<NonNullable<typeof deletedMetadata>>(
      `DELETE FROM local_bootstrap_metadata
       WHERE singleton = true
       RETURNING singleton, org_id::text, store_id::text, admin_staff_id::text,
                 profile_hash::text, demo_only, created_at`,
    );
    deletedMetadata = removed.rows[0];
    assert.ok(deletedMetadata);
    await assert.rejects(
      () => assertLocalBootstrapReady(appPool, expectedDemoOnly),
      /LOCAL_RUNTIME_NOT_READY/u,
    );
  } finally {
    if (ownerMembershipGranted) {
      await adminPool.query("REVOKE laundry_owner FROM laundry_app");
    }
    if (predefinedMembershipGranted) {
      await adminPool.query("REVOKE pg_write_all_data FROM laundry_app");
    }
    if (unsafeSearchPathPool !== undefined) {
      await unsafeSearchPathPool.end();
    }
    if (shadowSchemaCreated) {
      await adminPool.query("DROP SCHEMA runtime_shadow_probe");
    }
    if (deletedMetadata !== undefined) {
      await adminPool.query(
        `INSERT INTO local_bootstrap_metadata (
           singleton, org_id, store_id, admin_staff_id, profile_hash, demo_only, created_at
         ) VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7)`,
        [
          deletedMetadata.singleton,
          deletedMetadata.org_id,
          deletedMetadata.store_id,
          deletedMetadata.admin_staff_id,
          deletedMetadata.profile_hash,
          deletedMetadata.demo_only,
          deletedMetadata.created_at,
        ],
      );
    }
    await adminAsAppPool.end();
    await appPool.end();
    await adminPool.end();
  }
});
