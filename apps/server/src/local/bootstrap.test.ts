import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import type { PasswordPort } from "../identity/password.js";
import {
  BOOTSTRAP_ADMIN_ROLE_ID,
  BOOTSTRAP_APPROVER_ROLE_ID,
  BOOTSTRAP_APPROVER_STAFF_ID,
  BOOTSTRAP_COMMISSION_AUDIT_ID,
  BOOTSTRAP_FEATURE_ROW_ID,
  BootstrapError,
  BootstrapInputSchema,
  CommissionInputSchema,
  LOCAL_BOOTSTRAP_ADVISORY_LOCK_ID,
  bootstrapLocalIdentity,
  commissionLocalIdentity,
  computeBootstrapProfileHash,
  type BootstrapInput,
  type CommissionInput,
} from "./bootstrap.js";
import { LOCAL_PROFILE } from "./profile.js";

const PASSWORD_PHC = "$argon2id$v=19$m=19456,t=2,p=1$password$hash";
const PIN_PHC = "$argon2id$v=19$m=19456,t=2,p=1$pin$hash";
const serverPackagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
type QueryRecord = Readonly<{ sql: string; params: readonly unknown[] | undefined }>;
type QueryResult = Readonly<{ rows: readonly Record<string, unknown>[]; rowCount: number }>;

const input = (overrides: Partial<BootstrapInput> = {}): BootstrapInput =>
  Object.freeze({
    profile: LOCAL_PROFILE,
    adminUsername: "admin",
    adminDisplayName: "店长",
    adminPassword: "primary-password-sentinel",
    adminPin: "432165",
    approverUsername: "approver",
    approverDisplayName: "复核管理员",
    approverPassword: "approver-password-sentinel",
    approverPin: "987654",
    demoOnly: false,
    ...overrides,
  });

const commissionInput = (overrides: Partial<CommissionInput> = {}): CommissionInput =>
  Object.freeze({
    profile: LOCAL_PROFILE,
    approverUsername: "approver",
    approverDisplayName: "复核管理员",
    approverPassword: "approver-password-sentinel",
    approverPin: "987654",
    ...overrides,
  });

function passwordPort(events: string[] = [], verify = false): PasswordPort {
  return Object.freeze({
    hashPassword: async (value: string): Promise<string> => {
      events.push(`hash:${value}`);
      return /^\d{6,8}$/u.test(value) ? PIN_PHC : PASSWORD_PHC;
    },
    verifyPassword: async (): Promise<boolean> => verify,
  });
}

function poolFor(
  respond: (sql: string, params: readonly unknown[] | undefined) => QueryResult,
  options: Readonly<{ failOn?: string; rollbackFails?: boolean }> = {},
): Readonly<{ pool: PgPool; queries: QueryRecord[]; events: string[] }> {
  const queries: QueryRecord[] = [];
  const events: string[] = [];
  const client = {
    query: async (sql: string, params?: readonly unknown[]): Promise<QueryResult> => {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      queries.push(Object.freeze({ sql: normalized, params }));
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        events.push(normalized.toLowerCase());
        if (normalized === "ROLLBACK" && options.rollbackFails) throw new Error("rollback failed");
        return { rows: [], rowCount: 0 };
      }
      if (options.failOn !== undefined && normalized.startsWith(options.failOn)) {
        throw new Error("write failed with raw-secret");
      }
      return respond(normalized, params);
    },
    release: (): void => {
      events.push("release");
    },
  } as unknown as PgPoolClient;
  return Object.freeze({
    pool: Object.freeze({ connect: async () => client }) as unknown as PgPool,
    queries,
    events,
  });
}

const collisionFree = (): QueryResult => ({
  rows: [
    {
      org_id_exists: false,
      org_code_exists: false,
      store_id_exists: false,
      store_code_exists: false,
      admin_staff_id_exists: false,
      approver_staff_id_exists: false,
      admin_username_exists: false,
      approver_username_exists: false,
      admin_role_id_exists: false,
      approver_role_id_exists: false,
      feature_id_exists: false,
      audit_id_exists: false,
      demo_only_conflict: false,
    },
  ],
  rowCount: 1,
});

const createResponder = (sql: string): QueryResult => {
  if (sql.startsWith("SELECT singleton")) return { rows: [], rowCount: 0 };
  if (sql.includes("AS org_id_exists")) return collisionFree();
  return { rows: [], rowCount: 1 };
};

test("builds workspace dependencies before the package-local bootstrap CLI", () => {
  const packageJson = JSON.parse(readFileSync(serverPackagePath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.deepEqual(packageJson.scripts?.["bootstrap:local"]?.split(" && "), [
    "pnpm --filter @laundry/contracts build",
    "pnpm --filter @laundry/domain build",
    "pnpm run build",
    "node dist/local/bootstrap-cli.js",
  ]);
});

test("validates two independent administrators at the owner boundary", () => {
  assert.throws(
    () => BootstrapInputSchema.parse(input({ adminPassword: "short" })),
    /adminPassword/u,
  );
  assert.throws(() => BootstrapInputSchema.parse(input({ approverPin: "12345" })), /approverPin/u);
  assert.throws(
    () => BootstrapInputSchema.parse(input({ approverUsername: "admin" })),
    /approverUsername/u,
  );
  assert.throws(
    () =>
      BootstrapInputSchema.parse(
        input({
          approverPassword: "primary-password-sentinel",
        }),
      ),
    /approverPassword/u,
  );
  assert.throws(() => BootstrapInputSchema.parse(input({ approverPin: "432165" })), /approverPin/u);
  assert.equal(
    BootstrapInputSchema.parse(input({ adminDisplayName: " 店长 " })).adminDisplayName,
    "店长",
  );
  assert.equal(CommissionInputSchema.parse(commissionInput()).approverUsername, "approver");
});

test("profile hash is stable and excludes all credentials", () => {
  const first = computeBootstrapProfileHash(input());
  const changedCredentials = computeBootstrapProfileHash(
    input({
      adminPassword: "different-primary-password",
      adminPin: "123456",
      approverPassword: "different-approver-password",
      approverPin: "654321",
    }),
  );
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.equal(first, changedCredentials);
  assert.notEqual(first, computeBootstrapProfileHash(input({ adminDisplayName: "新店长" })));
});

test("fresh bootstrap atomically creates two admins, features, marker, and secret-free audit", async () => {
  const events: string[] = [];
  const database = poolFor(createResponder);
  const result = await bootstrapLocalIdentity(
    { pool: database.pool, passwordPort: passwordPort(events), now: () => new Date(0) },
    input(),
  );
  assert.equal(result.status, "created");
  assert.equal(result.approverStaffId, BOOTSTRAP_APPROVER_STAFF_ID);
  assert.deepEqual(
    events.slice().sort(),
    [
      "hash:432165",
      "hash:987654",
      "hash:approver-password-sentinel",
      "hash:primary-password-sentinel",
    ].sort(),
  );
  const inserts = database.queries.filter(({ sql }) => sql.startsWith("INSERT INTO"));
  assert.deepEqual(
    inserts.map(({ sql }) => sql.match(/^INSERT INTO ([a-z_]+)/u)?.[1]),
    [
      "orgs",
      "stores",
      "staffs",
      "staff_store_roles",
      "staffs",
      "staff_store_roles",
      "store_features",
      "local_bootstrap_metadata",
      "audit_log",
    ],
  );
  assert.deepEqual(database.queries[1]?.params, [LOCAL_BOOTSTRAP_ADVISORY_LOCK_ID]);
  const serialized = JSON.stringify(database.queries);
  for (const secret of [
    "primary-password-sentinel",
    "432165",
    "approver-password-sentinel",
    "987654",
  ])
    assert.equal(serialized.includes(secret), false);
  for (const expected of [
    PASSWORD_PHC,
    PIN_PHC,
    BOOTSTRAP_ADMIN_ROLE_ID,
    BOOTSTRAP_APPROVER_ROLE_ID,
    BOOTSTRAP_FEATURE_ROW_ID,
    BOOTSTRAP_COMMISSION_AUDIT_ID,
  ])
    assert.equal(serialized.includes(expected), true);
  assert.deepEqual(database.events, ["begin", "commit", "release"]);
});

const metadata = (profileHash: string, commissioned = true) => ({
  singleton: true,
  org_id: LOCAL_PROFILE.orgId,
  store_id: LOCAL_PROFILE.storeId,
  admin_staff_id: LOCAL_PROFILE.adminStaffId,
  approver_staff_id: commissioned ? BOOTSTRAP_APPROVER_STAFF_ID : null,
  profile_hash: profileHash,
  demo_only: false,
  commissioned_at: commissioned ? new Date(0) : null,
  feature_profile_version: commissioned ? 1 : 0,
});

const existingState = (profileHash: string) => ({
  metadata_org_id: LOCAL_PROFILE.orgId,
  metadata_store_id: LOCAL_PROFILE.storeId,
  metadata_admin_staff_id: LOCAL_PROFILE.adminStaffId,
  metadata_approver_staff_id: BOOTSTRAP_APPROVER_STAFF_ID,
  metadata_profile_hash: profileHash,
  metadata_demo_only: false,
  metadata_commissioned_at: new Date(0),
  metadata_feature_profile_version: 1,
  org_id: LOCAL_PROFILE.orgId,
  org_code: LOCAL_PROFILE.orgCode,
  org_name: LOCAL_PROFILE.orgName,
  org_demo_only: false,
  store_id: LOCAL_PROFILE.storeId,
  store_org_id: LOCAL_PROFILE.orgId,
  store_code: LOCAL_PROFILE.storeCode,
  store_name: LOCAL_PROFILE.storeName,
  store_timezone: LOCAL_PROFILE.timezone,
  admin_staff_id: LOCAL_PROFILE.adminStaffId,
  admin_org_id: LOCAL_PROFILE.orgId,
  admin_username: "admin",
  admin_password_hash: PASSWORD_PHC,
  admin_pin_hash: PIN_PHC,
  admin_display_name: "店长",
  admin_is_active: true,
  admin_permission_version: 1,
  admin_role_id: BOOTSTRAP_ADMIN_ROLE_ID,
  admin_role_name: "admin",
  admin_role_is_active: true,
  admin_role_is_privacy_admin: true,
  approver_staff_id: BOOTSTRAP_APPROVER_STAFF_ID,
  approver_org_id: LOCAL_PROFILE.orgId,
  approver_username: "approver",
  approver_password_hash: PASSWORD_PHC,
  approver_pin_hash: PIN_PHC,
  approver_display_name: "复核管理员",
  approver_is_active: true,
  approver_permission_version: 1,
  approver_role_id: BOOTSTRAP_APPROVER_ROLE_ID,
  approver_role_name: "admin",
  approver_role_is_active: true,
  approver_role_is_privacy_admin: true,
  feature_id: BOOTSTRAP_FEATURE_ROW_ID,
  fulfillment: true,
  membership: true,
  shift_closing: true,
  delivery: false,
  marketing: false,
  ai: false,
  audit_id: BOOTSTRAP_COMMISSION_AUDIT_ID,
});

test("bootstrap is idempotent only for a complete matching commissioned state", async () => {
  const hash = computeBootstrapProfileHash(input());
  const database = poolFor((sql) => {
    if (sql.startsWith("SELECT singleton")) return { rows: [metadata(hash)], rowCount: 1 };
    if (sql.includes("JOIN staffs approver")) return { rows: [existingState(hash)], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const result = await bootstrapLocalIdentity(
    { pool: database.pool, passwordPort: passwordPort([], true) },
    input(),
  );
  assert.equal(result.status, "unchanged");
  assert.equal(
    database.queries.some(({ sql }) => sql.startsWith("INSERT INTO")),
    false,
  );

  const legacy = poolFor((sql) =>
    sql.startsWith("SELECT singleton")
      ? { rows: [metadata(hash, false)], rowCount: 1 }
      : { rows: [], rowCount: 0 },
  );
  await assert.rejects(
    bootstrapLocalIdentity({ pool: legacy.pool, passwordPort: passwordPort() }, input()),
    (error: unknown) =>
      error instanceof BootstrapError && error.code === "BOOTSTRAP_STATE_CONFLICT",
  );
});

const legacyCommissionState = (overrides: Record<string, unknown> = {}) => ({
  metadata_org_id: LOCAL_PROFILE.orgId,
  metadata_store_id: LOCAL_PROFILE.storeId,
  metadata_admin_staff_id: LOCAL_PROFILE.adminStaffId,
  approver_staff_id: null,
  commissioned_at: null,
  feature_profile_version: 0,
  metadata_demo_only: false,
  org_code: LOCAL_PROFILE.orgCode,
  org_name: LOCAL_PROFILE.orgName,
  org_demo_only: false,
  store_code: LOCAL_PROFILE.storeCode,
  store_name: LOCAL_PROFILE.storeName,
  store_timezone: LOCAL_PROFILE.timezone,
  admin_is_active: true,
  admin_password_hash: PASSWORD_PHC,
  admin_pin_hash: PIN_PHC,
  admin_role_id: BOOTSTRAP_ADMIN_ROLE_ID,
  admin_role_name: "admin",
  admin_role_is_active: true,
  admin_role_is_privacy_admin: true,
  active_admin_count: 1,
  target_staff_id_exists: false,
  target_username_exists: false,
  target_role_id_exists: false,
  audit_id_exists: false,
  ...overrides,
});

test("legacy commission rejects a password or PIN reused from the existing administrator", async (t) => {
  for (const reused of ["approver-password-sentinel", "987654"] as const) {
    await t.test(reused === "987654" ? "PIN" : "password", async () => {
      const database = poolFor((sql) =>
        sql.startsWith("SELECT metadata.org_id")
          ? { rows: [legacyCommissionState()], rowCount: 1 }
          : { rows: [], rowCount: 1 },
      );
      const port = Object.freeze({
        ...passwordPort(),
        verifyPassword: async (value: string): Promise<boolean> => value === reused,
      });
      await assert.rejects(
        commissionLocalIdentity({ pool: database.pool, passwordPort: port }, commissionInput()),
        (error: unknown) =>
          error instanceof BootstrapError && error.code === "COMMISSION_STATE_CONFLICT",
      );
      assert.equal(
        database.queries.some(({ sql }) => sql.startsWith("INSERT INTO")),
        false,
      );
    });
  }
});

test("Runtime commission closes the exact legacy single-admin state in one transaction", async () => {
  const database = poolFor((sql) => {
    if (sql.startsWith("SELECT metadata.org_id")) {
      return { rows: [legacyCommissionState()], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const result = await commissionLocalIdentity(
    { pool: database.pool, passwordPort: passwordPort(), now: () => new Date(0) },
    commissionInput(),
  );
  assert.equal(result.status, "commissioned");
  assert.deepEqual(
    database.queries
      .filter(({ sql }) => /^(INSERT INTO|UPDATE)/u.test(sql))
      .map(({ sql }) => sql.match(/^(?:INSERT INTO|UPDATE) ([a-z_]+)/u)?.[1]),
    ["staffs", "staff_store_roles", "store_features", "local_bootstrap_metadata", "audit_log"],
  );
  const serialized = JSON.stringify(database.queries);
  assert.equal(serialized.includes("approver-password-sentinel"), false);
  assert.equal(serialized.includes("987654"), false);
});

test("Runtime commission fails closed after completion, with multiple admins, or on collision", async (t) => {
  const cases = [
    [
      "closed",
      legacyCommissionState({
        commissioned_at: new Date(0),
        approver_staff_id: BOOTSTRAP_APPROVER_STAFF_ID,
        feature_profile_version: 1,
      }),
      "COMMISSION_ALREADY_COMPLETE",
    ],
    [
      "multiple admins",
      legacyCommissionState({ active_admin_count: 2 }),
      "COMMISSION_STATE_CONFLICT",
    ],
    [
      "username collision",
      legacyCommissionState({ target_username_exists: true }),
      "COMMISSION_COLLISION",
    ],
  ] as const;
  for (const [name, row, code] of cases) {
    await t.test(name, async () => {
      const database = poolFor((sql) =>
        sql.startsWith("SELECT metadata.org_id")
          ? { rows: [row], rowCount: 1 }
          : { rows: [], rowCount: 1 },
      );
      await assert.rejects(
        commissionLocalIdentity(
          { pool: database.pool, passwordPort: passwordPort() },
          commissionInput(),
        ),
        (error: unknown) => error instanceof BootstrapError && error.code === code,
      );
      assert.equal(
        database.queries.some(({ sql }) => sql.startsWith("INSERT INTO")),
        false,
      );
    });
  }
});

test("owner transaction rolls back and sanitizes rollback failures", async () => {
  const database = poolFor(createResponder, { failOn: "INSERT INTO store_features" });
  await assert.rejects(
    bootstrapLocalIdentity({ pool: database.pool, passwordPort: passwordPort() }, input()),
    /write failed/u,
  );
  assert.deepEqual(database.events, ["begin", "rollback", "release"]);
  const brokenRollback = poolFor(createResponder, {
    failOn: "INSERT INTO store_features",
    rollbackFails: true,
  });
  await assert.rejects(
    bootstrapLocalIdentity({ pool: brokenRollback.pool, passwordPort: passwordPort() }, input()),
    (error: unknown) =>
      error instanceof BootstrapError && error.code === "BOOTSTRAP_ROLLBACK_FAILED",
  );
});
