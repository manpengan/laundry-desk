import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import type { PasswordPort } from "../identity/password.js";
import {
  BOOTSTRAP_ADMIN_ROLE_ID,
  BootstrapError,
  BootstrapInputSchema,
  LOCAL_BOOTSTRAP_ADVISORY_LOCK_ID,
  bootstrapLocalIdentity,
  computeBootstrapProfileHash,
  type BootstrapInput,
} from "./bootstrap.js";
import { LOCAL_PROFILE } from "./profile.js";

const PASSWORD_PHC = "$argon2id$v=19$m=19456,t=2,p=1$password$hash";
const PIN_PHC = "$argon2id$v=19$m=19456,t=2,p=1$pin$hash";
const serverPackagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
type QueryRecord = Readonly<{
  sql: string;
  params: readonly unknown[] | undefined;
}>;

type OrgState = Readonly<{
  id: string;
  code: string;
  name: string;
  demoOnly: boolean;
}>;

type StoreState = Readonly<{
  id: string;
  orgId: string;
  code: string;
  name: string;
  timezone: string;
}>;

type StaffState = Readonly<{
  id: string;
  orgId: string;
  username: string;
  passwordHash: string;
  pinHash: string;
  displayName: string;
  isActive: boolean;
  permissionVersion: number;
}>;

type RoleState = Readonly<{
  id: string;
  orgId: string;
  storeId: string;
  staffId: string;
  role: string;
  isActive: boolean;
}>;

type MetadataState = Readonly<{
  orgId: string;
  storeId: string;
  adminStaffId: string;
  profileHash: string;
  demoOnly: boolean;
}>;

type FakeDatabaseState = Readonly<{
  org?: OrgState;
  store?: StoreState;
  staff?: StaffState;
  role?: RoleState;
  metadata?: MetadataState;
}>;

type WriteKind = "org" | "store" | "staff" | "role" | "metadata";

type FakeDatabase = Readonly<{
  pool: PgPool;
  queries: QueryRecord[];
  events: string[];
  snapshot: () => FakeDatabaseState;
  replaceState: (state: FakeDatabaseState) => void;
}>;

const emptyState = Object.freeze({}) satisfies FakeDatabaseState;

function createMutex(): Readonly<{ acquire: () => Promise<() => void> }> {
  let tail = Promise.resolve();

  return Object.freeze({
    acquire: async (): Promise<() => void> => {
      let releaseCurrent: (() => void) | undefined;
      const current = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
      const previous = tail;
      tail = previous.then(() => current);
      await previous;
      return (): void => {
        releaseCurrent?.();
      };
    },
  });
}

function createFakeDatabase(
  options?: Readonly<{
    initialState?: FakeDatabaseState;
    failAt?: WriteKind;
  }>,
): FakeDatabase {
  let state: FakeDatabaseState = options?.initialState ?? emptyState;
  const queries: QueryRecord[] = [];
  const events: string[] = [];
  const mutex = createMutex();

  const pool = {
    connect: async (): Promise<PgPoolClient> => {
      events.push("connect");
      let staged: FakeDatabaseState = emptyState;
      let releaseLock: (() => void) | undefined;

      const query = async (
        sql: string,
        params?: readonly unknown[],
      ): Promise<Readonly<{ rows: readonly unknown[]; rowCount: number }>> => {
        queries.push(Object.freeze({ sql, params }));
        const normalized = sql.replace(/\s+/gu, " ").trim();

        if (normalized === "BEGIN") {
          events.push("begin");
          return { rows: [], rowCount: 0 };
        }
        if (normalized.includes("pg_advisory_xact_lock")) {
          releaseLock = await mutex.acquire();
          events.push("locked");
          return { rows: [], rowCount: 1 };
        }
        if (normalized === "SET LOCAL ROLE laundry_owner") {
          events.push("owner-role");
          return { rows: [], rowCount: 0 };
        }
        if (
          normalized.includes("FROM local_bootstrap_metadata") &&
          normalized.includes("FOR UPDATE") &&
          !normalized.includes("JOIN orgs")
        ) {
          const metadata = state.metadata;
          return {
            rows:
              metadata === undefined
                ? []
                : [
                    {
                      singleton: true,
                      org_id: metadata.orgId,
                      store_id: metadata.storeId,
                      admin_staff_id: metadata.adminStaffId,
                      profile_hash: metadata.profileHash,
                      demo_only: metadata.demoOnly,
                    },
                  ],
            rowCount: metadata === undefined ? 0 : 1,
          };
        }
        if (
          normalized.includes("FROM local_bootstrap_metadata") &&
          normalized.includes("JOIN orgs")
        ) {
          const { metadata, org, store, staff, role } = state;
          if (
            metadata === undefined ||
            org === undefined ||
            store === undefined ||
            staff === undefined ||
            role === undefined
          ) {
            return { rows: [], rowCount: 0 };
          }
          return {
            rows: [
              {
                metadata_org_id: metadata.orgId,
                metadata_store_id: metadata.storeId,
                metadata_admin_staff_id: metadata.adminStaffId,
                metadata_profile_hash: metadata.profileHash,
                metadata_demo_only: metadata.demoOnly,
                org_id: org.id,
                org_code: org.code,
                org_name: org.name,
                org_demo_only: org.demoOnly,
                store_id: store.id,
                store_org_id: store.orgId,
                store_code: store.code,
                store_name: store.name,
                store_timezone: store.timezone,
                admin_staff_id: staff.id,
                admin_org_id: staff.orgId,
                admin_username: staff.username,
                admin_password_hash: staff.passwordHash,
                admin_pin_hash: staff.pinHash,
                admin_display_name: staff.displayName,
                admin_is_active: staff.isActive,
                admin_permission_version: staff.permissionVersion,
                role_id: role.id,
                role_org_id: role.orgId,
                role_store_id: role.storeId,
                role_staff_id: role.staffId,
                role_name: role.role,
                role_is_active: role.isActive,
              },
            ],
            rowCount: 1,
          };
        }
        if (normalized.includes("AS org_id_exists")) {
          const requestedOrgId = String(params?.[0]);
          const requestedOrgCode = String(params?.[1]);
          const requestedStoreId = String(params?.[2]);
          const requestedStoreCode = String(params?.[3]);
          const requestedStaffId = String(params?.[4]);
          const requestedUsername = String(params?.[5]);
          const requestedRoleId = String(params?.[6]);
          const requestedDemoOnly = Boolean(params?.[7]);
          const demoConflict =
            !requestedDemoOnly &&
            state.org !== undefined &&
            state.org.demoOnly &&
            (state.org.id === requestedOrgId || state.org.code === requestedOrgCode);

          return {
            rows: [
              {
                org_id_exists: state.org?.id === requestedOrgId,
                org_code_exists: state.org?.code === requestedOrgCode,
                store_id_exists: state.store?.id === requestedStoreId,
                store_code_exists:
                  state.store?.orgId === requestedOrgId && state.store?.code === requestedStoreCode,
                staff_id_exists: state.staff?.id === requestedStaffId,
                staff_username_exists:
                  state.staff?.orgId === requestedOrgId &&
                  state.staff?.username === requestedUsername,
                role_id_exists: state.role?.id === requestedRoleId,
                demo_only_conflict: demoConflict,
              },
            ],
            rowCount: 1,
          };
        }

        const failOrStage = (kind: WriteKind, next: FakeDatabaseState): void => {
          if (options?.failAt === kind) {
            throw new Error(`write-failed-${kind}-raw-secret`);
          }
          staged = Object.freeze({ ...staged, ...next });
        };

        if (normalized.startsWith("INSERT INTO orgs")) {
          failOrStage("org", {
            org: Object.freeze({
              id: String(params?.[0]),
              code: String(params?.[1]),
              name: String(params?.[2]),
              demoOnly: Boolean(params?.[3]),
            }),
          });
          return { rows: [], rowCount: 1 };
        }
        if (normalized.startsWith("INSERT INTO stores")) {
          failOrStage("store", {
            store: Object.freeze({
              id: String(params?.[0]),
              orgId: String(params?.[1]),
              code: String(params?.[2]),
              name: String(params?.[3]),
              timezone: String(params?.[4]),
            }),
          });
          return { rows: [], rowCount: 1 };
        }
        if (normalized.startsWith("INSERT INTO staffs")) {
          failOrStage("staff", {
            staff: Object.freeze({
              id: String(params?.[0]),
              orgId: String(params?.[1]),
              username: String(params?.[2]),
              passwordHash: String(params?.[3]),
              pinHash: String(params?.[4]),
              displayName: String(params?.[5]),
              isActive: true,
              permissionVersion: 1,
            }),
          });
          return { rows: [], rowCount: 1 };
        }
        if (normalized.startsWith("INSERT INTO staff_store_roles")) {
          failOrStage("role", {
            role: Object.freeze({
              id: String(params?.[0]),
              orgId: String(params?.[1]),
              storeId: String(params?.[2]),
              staffId: String(params?.[3]),
              role: String(params?.[4]),
              isActive: true,
            }),
          });
          return { rows: [], rowCount: 1 };
        }
        if (normalized.startsWith("INSERT INTO local_bootstrap_metadata")) {
          failOrStage("metadata", {
            metadata: Object.freeze({
              orgId: String(params?.[0]),
              storeId: String(params?.[1]),
              adminStaffId: String(params?.[2]),
              profileHash: String(params?.[3]),
              demoOnly: Boolean(params?.[4]),
            }),
          });
          return { rows: [], rowCount: 1 };
        }
        if (normalized === "COMMIT") {
          state = Object.freeze({ ...state, ...staged });
          staged = emptyState;
          releaseLock?.();
          releaseLock = undefined;
          events.push("commit");
          return { rows: [], rowCount: 0 };
        }
        if (normalized === "ROLLBACK") {
          staged = emptyState;
          releaseLock?.();
          releaseLock = undefined;
          events.push("rollback");
          return { rows: [], rowCount: 0 };
        }

        throw new Error(`unexpected SQL: ${normalized}`);
      };

      return {
        query,
        release(): void {
          releaseLock?.();
          events.push("release");
        },
      } as unknown as PgPoolClient;
    },
  } as unknown as PgPool;

  return Object.freeze({
    pool,
    queries,
    events,
    snapshot: () => state,
    replaceState: (nextState: FakeDatabaseState): void => {
      state = Object.freeze({ ...nextState });
    },
  });
}

function createPasswordPort(events: string[] = []): PasswordPort {
  return Object.freeze({
    hashPassword: async (value: string): Promise<string> => {
      events.push(`hash:${value}`);
      return /^\d{4,8}$/u.test(value) ? PIN_PHC : PASSWORD_PHC;
    },
    verifyPassword: async (value: string, storedHash: string): Promise<boolean> => {
      if (/^\d{4,8}$/u.test(value)) {
        return storedHash === PIN_PHC;
      }
      return storedHash === PASSWORD_PHC;
    },
  });
}

function input(overrides: Partial<BootstrapInput> = {}): BootstrapInput {
  return Object.freeze({
    profile: LOCAL_PROFILE,
    adminUsername: "admin",
    adminDisplayName: "店长",
    adminPassword: "password-sentinel",
    adminPin: "4321",
    demoOnly: false,
    ...overrides,
  });
}

test("builds workspace dependencies before the package-local bootstrap CLI", () => {
  const serverPackage = JSON.parse(readFileSync(serverPackagePath, "utf8")) as Readonly<{
    scripts?: Readonly<Record<string, string>>;
  }>;

  assert.deepEqual(serverPackage.scripts?.["bootstrap:local"]?.split(" && "), [
    "pnpm --filter @laundry/contracts build",
    "pnpm --filter @laundry/domain build",
    "pnpm run build",
    "node dist/local/bootstrap-cli.js",
  ]);
});

test("validates the fixed local profile and every external admin boundary", () => {
  assert.throws(
    () => BootstrapInputSchema.parse(input({ adminUsername: "not visible" })),
    /adminUsername/u,
  );
  assert.throws(
    () => BootstrapInputSchema.parse(input({ adminDisplayName: "   " })),
    /adminDisplayName/u,
  );
  assert.throws(() => BootstrapInputSchema.parse(input({ adminPassword: "" })), /adminPassword/u);
  assert.throws(() => BootstrapInputSchema.parse(input({ adminPin: "123" })), /adminPin/u);
  assert.throws(
    () =>
      BootstrapInputSchema.parse(
        input({
          profile: Object.freeze({
            ...LOCAL_PROFILE,
            orgName: "other",
          }) as unknown as typeof LOCAL_PROFILE,
        }),
      ),
    /profile/u,
  );

  const parsed = BootstrapInputSchema.parse(input({ adminDisplayName: "  店长  " }));
  assert.equal(parsed.adminDisplayName, "店长");
  assert.equal(Object.isFrozen(parsed), true);
});

test("computes a stable lowercase SHA-256 over versioned non-secret metadata only", () => {
  const base = input();
  const first = computeBootstrapProfileHash(base);
  const second = computeBootstrapProfileHash(base);
  const credentialsChanged = computeBootstrapProfileHash(
    input({ adminPassword: "another-password", adminPin: "8765" }),
  );
  const profileChanged = computeBootstrapProfileHash(input({ adminDisplayName: "新店长" }));

  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.equal(first, second);
  assert.equal(first, credentialsChanged);
  assert.notEqual(first, profileChanged);
});

test("hashes credentials before connecting and creates the four identity rows with metadata last", async () => {
  const database = createFakeDatabase();
  const passwordPort = createPasswordPort(database.events);

  const result = await bootstrapLocalIdentity(
    Object.freeze({ pool: database.pool, passwordPort }),
    input(),
  );

  assert.deepEqual(result, {
    status: "created",
    orgId: LOCAL_PROFILE.orgId,
    storeId: LOCAL_PROFILE.storeId,
    adminStaffId: LOCAL_PROFILE.adminStaffId,
    demoOnly: false,
  });
  assert.deepEqual(database.events.slice(0, 3), ["hash:password-sentinel", "hash:4321", "connect"]);

  const sqlSequence = database.queries.map((query) => query.sql.replace(/\s+/gu, " ").trim());
  assert.equal(sqlSequence[0], "BEGIN");
  assert.match(sqlSequence[1] ?? "", /pg_advisory_xact_lock/u);
  assert.deepEqual(database.queries[1]?.params, [LOCAL_BOOTSTRAP_ADVISORY_LOCK_ID]);
  assert.equal(sqlSequence[2], "SET LOCAL ROLE laundry_owner");
  assert.match(sqlSequence[3] ?? "", /local_bootstrap_metadata[\s\S]*FOR UPDATE/u);
  assert.deepEqual(
    sqlSequence
      .filter((sql) => sql.startsWith("INSERT INTO"))
      .map((sql) => sql.match(/^INSERT INTO ([a-z_]+)/u)?.[1]),
    ["orgs", "stores", "staffs", "staff_store_roles", "local_bootstrap_metadata"],
  );
  assert.equal(sqlSequence.at(-1), "COMMIT");

  const serializedParams = JSON.stringify(database.queries.map((query) => query.params));
  assert.equal(serializedParams.includes("password-sentinel"), false);
  assert.equal(serializedParams.includes("4321"), false);
  assert.equal(serializedParams.includes(PASSWORD_PHC), true);
  assert.equal(serializedParams.includes(PIN_PHC), true);

  const state = database.snapshot();
  assert.equal(state.org?.demoOnly, false);
  assert.equal(state.role?.id, BOOTSTRAP_ADMIN_ROLE_ID);
  assert.equal(state.role?.role, "admin");
  assert.equal(state.metadata?.profileHash, computeBootstrapProfileHash(input()));
});

test("returns unchanged without writes only when metadata and complete actual state match", async () => {
  const database = createFakeDatabase();
  const deps = Object.freeze({ pool: database.pool, passwordPort: createPasswordPort() });

  const first = await bootstrapLocalIdentity(deps, input());
  const insertsAfterCreate = database.queries.filter((query) =>
    query.sql.replace(/\s+/gu, " ").trim().startsWith("INSERT INTO"),
  ).length;
  const second = await bootstrapLocalIdentity(deps, input());
  const insertsAfterRerun = database.queries.filter((query) =>
    query.sql.replace(/\s+/gu, " ").trim().startsWith("INSERT INTO"),
  ).length;

  assert.equal(first.status, "created");
  assert.equal(second.status, "unchanged");
  assert.equal(insertsAfterCreate, 5);
  assert.equal(insertsAfterRerun, insertsAfterCreate);
  assert.equal(database.events.filter((event) => event === "commit").length, 2);
});

test("fails closed when stored metadata exists but any actual admin role state drifts", async () => {
  const database = createFakeDatabase();
  const deps = Object.freeze({ pool: database.pool, passwordPort: createPasswordPort() });
  await bootstrapLocalIdentity(deps, input());
  const created = database.snapshot();
  assert.notEqual(created.role, undefined);
  if (created.role === undefined) {
    throw new Error("created bootstrap must persist an admin role");
  }
  database.replaceState(
    Object.freeze({
      ...created,
      role: Object.freeze({ ...created.role, role: "staff" }),
    }),
  );
  const insertsBefore = database.queries.filter((query) =>
    query.sql.replace(/\s+/gu, " ").trim().startsWith("INSERT INTO"),
  ).length;

  await assert.rejects(
    bootstrapLocalIdentity(deps, input()),
    (error: unknown) =>
      error instanceof BootstrapError && error.code === "BOOTSTRAP_STATE_CONFLICT",
  );

  const insertsAfter = database.queries.filter((query) =>
    query.sql.replace(/\s+/gu, " ").trim().startsWith("INSERT INTO"),
  ).length;
  assert.equal(insertsAfter, insertsBefore);
  assert.equal(database.events.at(-2), "rollback");
});

test("preflight rejects ID, code, username, or demo-only collisions before every write", async (t) => {
  const collisions: ReadonlyArray<Readonly<{ name: string; state: FakeDatabaseState }>> = [
    {
      name: "org id",
      state: { org: { id: LOCAL_PROFILE.orgId, code: "other", name: "Other", demoOnly: false } },
    },
    {
      name: "store code",
      state: {
        store: {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          orgId: LOCAL_PROFILE.orgId,
          code: LOCAL_PROFILE.storeCode,
          name: "Other",
          timezone: LOCAL_PROFILE.timezone,
        },
      },
    },
    {
      name: "username",
      state: {
        staff: {
          id: "22222222-2222-4222-8222-222222222222",
          orgId: LOCAL_PROFILE.orgId,
          username: "admin",
          passwordHash: PASSWORD_PHC,
          pinHash: PIN_PHC,
          displayName: "Other",
          isActive: true,
          permissionVersion: 1,
        },
      },
    },
  ];

  for (const collision of collisions) {
    await t.test(collision.name, async () => {
      const database = createFakeDatabase({ initialState: collision.state });
      await assert.rejects(
        bootstrapLocalIdentity(
          Object.freeze({ pool: database.pool, passwordPort: createPasswordPort() }),
          input(),
        ),
        (error: unknown) => error instanceof BootstrapError && error.code === "BOOTSTRAP_COLLISION",
      );
      assert.equal(
        database.queries.some((query) =>
          query.sql.replace(/\s+/gu, " ").trim().startsWith("INSERT INTO"),
        ),
        false,
      );
    });
  }

  await t.test("non-demo cannot reuse demo organization", async () => {
    const database = createFakeDatabase({
      initialState: {
        org: {
          id: LOCAL_PROFILE.orgId,
          code: LOCAL_PROFILE.orgCode,
          name: LOCAL_PROFILE.orgName,
          demoOnly: true,
        },
      },
    });
    await assert.rejects(
      bootstrapLocalIdentity(
        Object.freeze({ pool: database.pool, passwordPort: createPasswordPort() }),
        input({ demoOnly: false }),
      ),
      (error: unknown) =>
        error instanceof BootstrapError && error.code === "BOOTSTRAP_DEMO_CONFLICT",
    );
  });
});

test("rolls back each partial write failure without commit or persisted metadata", async (t) => {
  for (const failAt of ["org", "store", "staff", "role", "metadata"] as const) {
    await t.test(failAt, async () => {
      const database = createFakeDatabase({ failAt });
      await assert.rejects(
        bootstrapLocalIdentity(
          Object.freeze({ pool: database.pool, passwordPort: createPasswordPort() }),
          input(),
        ),
        new RegExp(`write-failed-${failAt}`, "u"),
      );

      assert.equal(database.events.includes("commit"), false);
      assert.equal(database.events.includes("rollback"), true);
      assert.equal(database.snapshot().metadata, undefined);
      assert.equal(database.queries.at(-1)?.sql, "ROLLBACK");
    });
  }
});

test("serializes two identical calls into one creation and one unchanged result", async () => {
  const database = createFakeDatabase();
  const deps = Object.freeze({ pool: database.pool, passwordPort: createPasswordPort() });

  const results = await Promise.all([
    bootstrapLocalIdentity(deps, input()),
    bootstrapLocalIdentity(deps, input()),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), ["created", "unchanged"]);
  assert.equal(database.events.filter((event) => event === "locked").length, 2);
  assert.equal(database.events.filter((event) => event === "commit").length, 2);
  const insertTables = database.queries
    .map((query) => query.sql.replace(/\s+/gu, " ").trim())
    .filter((sql) => sql.startsWith("INSERT INTO"))
    .map((sql) => sql.match(/^INSERT INTO ([a-z_]+)/u)?.[1]);
  assert.equal(insertTables.length, 5);
  assert.deepEqual(insertTables, [
    "orgs",
    "stores",
    "staffs",
    "staff_store_roles",
    "local_bootstrap_metadata",
  ]);
});

test("serializes two different calls into one creation and one safe conflict", async () => {
  const database = createFakeDatabase();
  const deps = Object.freeze({ pool: database.pool, passwordPort: createPasswordPort() });

  const results = await Promise.allSettled([
    bootstrapLocalIdentity(deps, input()),
    bootstrapLocalIdentity(deps, input({ adminDisplayName: "另一位店长" })),
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled" && result.value.status === "created")
      .length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected?.status, "rejected");
  if (rejected?.status === "rejected") {
    assert.equal(rejected.reason instanceof BootstrapError, true);
    assert.equal((rejected.reason as BootstrapError).code, "BOOTSTRAP_STATE_CONFLICT");
  }
  assert.equal(database.events.filter((event) => event === "commit").length, 1);
  assert.equal(database.events.filter((event) => event === "rollback").length, 1);
});
