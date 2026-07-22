/**
 * Postgres identity store integration — skipped when DATABASE_URL / LAUNDRY_USE_LOCAL_PG unset.
 * Against compose: LAUNDRY_USE_LOCAL_PG=1 node --test dist/identity/pg-store.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createPgPool,
  LOCAL_PG_URLS,
  resolveIdentityDatabaseUrl,
} from "../db/pg-pool.js";
import { createPgIdentityStore } from "./pg-store.js";
import { seedDemoIdentity } from "../local/pg-seed.js";
import { DEMO_PASSWORD, DEMO_PIN } from "../local/demo-ids.js";
import { createScryptPasswordPort } from "./password.js";
import { loginWithPassword } from "./login.js";
import { createAccessTokenSigner } from "./crypto-util.js";
import { createQuickSwitchChallenge, verifyQuickSwitchPin } from "./pin.js";
import { DEMO_STAFF_A_ID } from "../local/demo-ids.js";

const url = resolveIdentityDatabaseUrl({
  ...process.env,
  LAUNDRY_USE_LOCAL_PG: process.env.LAUNDRY_USE_LOCAL_PG ?? "1",
  DATABASE_URL: process.env.DATABASE_URL ?? LOCAL_PG_URLS.admin,
});

const maybe =
  process.env.LAUNDRY_SKIP_PG_TEST === "1"
    ? test.skip
    : url === null
      ? test.skip
      : test;

maybe("PG seed + login + PIN quick-switch", async () => {
  assert.ok(url);
  const pool = createPgPool({ connectionString: url });
  try {
    await seedDemoIdentity(pool);
    const store = createPgIdentityStore(pool);
    const passwordPort = createScryptPasswordPort();
    const clock = { nowEpochSeconds: () => Math.floor(Date.now() / 1000) };
    const sessions = {
      sessions: store.sessions,
      refresh: store.refresh,
      clock,
      accessTokenSigner: createAccessTokenSigner("pg-test-secret"),
    };
    const loginDeps = {
      staff: store.staff,
      orgStore: store.orgStore,
      passwordPort,
      sessions,
    };
    const issued = await loginWithPassword(loginDeps, {
      org_code: "hongfa",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    assert.equal(issued.storage, "memory_only");
    assert.ok(issued.access_token.length > 10);

    const session = await store.sessions.get(issued.session.session_id);
    assert.ok(session);
    assert.equal(session.status, "active");
    assert.ok(session.family_id.length > 0);

    const pinDeps = {
      challenges: store.pinChallenges,
      lockouts: store.pinLockouts,
      staff: store.staff,
      pinPort: passwordPort,
      clock,
      sessions,
    };
    const challenge = await createQuickSwitchChallenge(pinDeps, {
      purpose: "quick_switch",
      session,
      target_staff_id: DEMO_STAFF_A_ID,
    });
    const switched = await verifyQuickSwitchPin(pinDeps, {
      challenge_id: challenge.challenge_id,
      pin: DEMO_PIN,
      session,
    });
    assert.equal(switched.session.staff_id, DEMO_STAFF_A_ID);

    const bad = await loginWithPassword(loginDeps, {
      org_code: "hongfa",
      store_code: "main",
      username: "admin",
      password: "wrong",
      device_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(bad);
  } finally {
    await pool.end();
  }
});
