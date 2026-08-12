import assert from "node:assert/strict";
import test from "node:test";

import { AccessSessionResponseSchema } from "@laundry/contracts";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { loginWithPassword } from "../identity/login.js";
import type { SessionIssueResult } from "../identity/types.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD, type LocalRuntime } from "../local/demo-seed.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import type { StoreFeatureFlags } from "../platform/features.js";
import { buildAccessSessionResponse, prepareAccessSessionProjection } from "./session-view.js";

const DEVICE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_STORE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_STAFF_ID = "33333333-3333-4333-8333-333333333333";

const DATABASE_FEATURES: StoreFeatureFlags = Object.freeze({
  fulfillment: false,
  membership: true,
  shift_closing: true,
  delivery: false,
  marketing: true,
  ai: false,
});

async function issueAdmin(runtime: LocalRuntime): Promise<SessionIssueResult> {
  return loginWithPassword(runtime.identity.login, {
    org_code: LOCAL_PROFILE.orgCode,
    store_code: LOCAL_PROFILE.storeCode,
    username: "admin",
    password: DEMO_PASSWORD,
    device_id: DEVICE_ID,
  });
}

function createFeaturePool(
  features: StoreFeatureFlags,
  events: Array<Readonly<{ sql: string; params: readonly unknown[] }>>,
  authorityRole: "admin" | "staff" = "staff",
): PgPool {
  const client = Object.freeze({
    async query(sql: string, params: readonly unknown[] = []) {
      events.push(Object.freeze({ sql, params: Object.freeze([...params]) }));
      if (/SELECT fulfillment, membership, shift_closing, delivery, marketing, ai/u.test(sql)) {
        return Object.freeze({ rows: Object.freeze([features]), rowCount: 1 });
      }
      if (/FROM staffs staff/u.test(sql)) {
        return Object.freeze({
          rows: Object.freeze([
            Object.freeze({
              staff_id: typeof params[2] === "string" ? params[2] : LOCAL_PROFILE.adminStaffId,
              display_name: "数据库店长",
              permission_version: 1,
              role: authorityRole,
              is_privacy_admin: false,
            }),
          ]),
          rowCount: 1,
        });
      }
      if (/FROM orgs AS org/u.test(sql)) {
        const other = params[0] === OTHER_ORG_ID;
        return Object.freeze({
          rows: Object.freeze([
            Object.freeze({
              org_code: other ? "network" : LOCAL_PROFILE.orgCode,
              store_code: other ? "branch-2" : LOCAL_PROFILE.storeCode,
              store_name: other ? "城北分店" : LOCAL_PROFILE.storeName,
            }),
          ]),
          rowCount: 1,
        });
      }
      return Object.freeze({ rows: Object.freeze([]), rowCount: null });
    },
    release() {},
  }) as unknown as PgPoolClient;
  return Object.freeze({
    async connect() {
      return client;
    },
  }) as unknown as PgPool;
}

test("builds a deeply frozen access-session projection from server repositories", async () => {
  const runtime = await createMemoryLocalRuntime();
  assert.ok(runtime.platform.features.put);
  await runtime.platform.features.put(LOCAL_PROFILE.storeId, DATABASE_FEATURES);
  const issued = await issueAdmin(runtime);

  const projection = await prepareAccessSessionProjection(runtime, issued.session);
  assert.ok(projection);
  const response = buildAccessSessionResponse(issued, projection);

  assert.deepEqual(AccessSessionResponseSchema.parse(response), response);
  assert.equal(response.role, "admin");
  assert.deepEqual(response.features, {
    ai_enabled: false,
    member_enabled: true,
    fulfillment_enabled: false,
    shift_closing_enabled: true,
    delivery_enabled: false,
    marketing_enabled: true,
  });
  assert.deepEqual(response.display, {
    store_name: LOCAL_PROFILE.storeName,
    staff_name: "店长",
    org_code: LOCAL_PROFILE.orgCode,
    store_code: LOCAL_PROFILE.storeCode,
  });
  assert.equal(Object.isFrozen(response), true);
  assert.equal(Object.isFrozen(response.session), true);
  assert.equal(Object.isFrozen(response.features), true);
  assert.equal(Object.isFrozen(response.display), true);
});

test("rejects an issued session absent from the server staff authority", async () => {
  const runtime = await createMemoryLocalRuntime();
  const issued = await issueAdmin(runtime);
  const missingAuthorityRuntime: LocalRuntime = Object.freeze({
    ...runtime,
    staffDirectory: Object.freeze([]),
  });

  assert.equal(await prepareAccessSessionProjection(missingAuthorityRuntime, issued.session), null);
});

test("PG session projection reads real SQL store_features instead of the memory placeholder", async () => {
  const runtime = await createMemoryLocalRuntime();
  const issued = await issueAdmin(runtime);
  const events: Array<Readonly<{ sql: string; params: readonly unknown[] }>> = [];
  const pool = createFeaturePool(DATABASE_FEATURES, events);
  const pgRuntime: LocalRuntime = Object.freeze({
    ...runtime,
    mode: "pg",
    pool,
    platform: Object.freeze({
      ...runtime.platform,
      persistence: "sql",
      features: Object.freeze({
        async get(): Promise<StoreFeatureFlags> {
          throw new Error("memory feature placeholder must not be used in PG mode");
        },
      }),
    }),
  });

  const projection = await prepareAccessSessionProjection(pgRuntime, issued.session);
  assert.ok(projection);
  const response = buildAccessSessionResponse(issued, projection);

  assert.equal(response.role, "staff");
  assert.equal(response.display.staff_name, "数据库店长");
  assert.equal(response.features.marketing_enabled, true);
  assert.equal(response.features.fulfillment_enabled, false);
  assert.ok(
    events.some((event) => /FROM store_features/u.test(event.sql)),
    "expected a store_features SQL read",
  );
  assert.ok(
    events.some(
      (event) =>
        /set_config\('app\.org_id'/u.test(event.sql) && event.params[0] === issued.session.org_id,
    ),
    "expected authenticated org GUC",
  );
  assert.ok(
    events.some(
      (event) =>
        /set_config\('app\.store_id'/u.test(event.sql) &&
        event.params[0] === issued.session.store_id,
    ),
    "expected authenticated store GUC",
  );
});

test("PG session projection accepts an authenticated non-bootstrap store and reads its display", async () => {
  const runtime = await createMemoryLocalRuntime();
  const events: Array<Readonly<{ sql: string; params: readonly unknown[] }>> = [];
  const pgRuntime: LocalRuntime = Object.freeze({
    ...runtime,
    mode: "pg",
    pool: createFeaturePool(DATABASE_FEATURES, events, "admin"),
  });

  const projection = await prepareAccessSessionProjection(pgRuntime, {
    org_id: OTHER_ORG_ID,
    store_id: OTHER_STORE_ID,
    staff_id: OTHER_STAFF_ID,
    permission_version: 1,
  });

  assert.ok(projection);
  assert.deepEqual(projection.display, {
    store_name: "城北分店",
    staff_name: "数据库店长",
    org_code: "network",
    store_code: "branch-2",
  });
  assert.equal(projection.org_id, OTHER_ORG_ID);
  assert.equal(projection.store_id, OTHER_STORE_ID);
  assert.equal(projection.staff_id, OTHER_STAFF_ID);
  assert.ok(
    events.some(
      (event) =>
        /FROM orgs AS org/u.test(event.sql) &&
        event.params[0] === OTHER_ORG_ID &&
        event.params[1] === OTHER_STORE_ID,
    ),
  );
});

test("PG session projection rejects a non-bootstrap staff authority", async () => {
  const runtime = await createMemoryLocalRuntime();
  const events: Array<Readonly<{ sql: string; params: readonly unknown[] }>> = [];
  const pgRuntime: LocalRuntime = Object.freeze({
    ...runtime,
    mode: "pg",
    pool: createFeaturePool(DATABASE_FEATURES, events, "staff"),
  });

  assert.equal(
    await prepareAccessSessionProjection(pgRuntime, {
      org_id: OTHER_ORG_ID,
      store_id: OTHER_STORE_ID,
      staff_id: OTHER_STAFF_ID,
      permission_version: 1,
    }),
    null,
  );
  assert.equal(
    events.some((event) => /FROM store_features/u.test(event.sql)),
    false,
  );
});

test("prepared projection cannot be applied to a different permission version", async () => {
  const runtime = await createMemoryLocalRuntime();
  const issued = await issueAdmin(runtime);
  const projection = await prepareAccessSessionProjection(runtime, issued.session);
  assert.ok(projection);

  assert.throws(
    () =>
      buildAccessSessionResponse(
        Object.freeze({
          ...issued,
          session: Object.freeze({
            ...issued.session,
            permission_version: issued.session.permission_version + 1,
          }),
        }),
        projection,
      ),
    /does not match/u,
  );
});
