/**
 * Postgres identity store integration — skipped when PG env unset.
 * Against compose: LAUNDRY_USE_LOCAL_PG=1 node --test dist/identity/pg-store.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { createPgIdentityStore } from "./pg-store.js";
import { seedDemoIdentity } from "../local/pg-seed.js";
import { DEMO_ADMIN_ID, DEMO_PASSWORD, DEMO_PIN, DEMO_STAFF_A_ID } from "../local/demo-ids.js";
import { createScryptPasswordPort } from "./password.js";
import { loginWithPassword } from "./login.js";
import { createAccessTokenSigner } from "./crypto-util.js";
import { createQuickSwitchChallenge, verifyQuickSwitchPin } from "./pin.js";
import { rotateRefresh } from "./session.js";

// CI has no compose Postgres — only run when explicitly opted in.
const pgOptIn =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true";
const urls = pgOptIn ? resolvePgUrls(process.env) : null;

const maybe = urls === null ? test.skip : test;

maybe("PG seed + login + PIN + refresh via laundry_app", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });
  try {
    await seedDemoIdentity(adminPool);
    const store = createPgIdentityStore(appPool);
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

    // pin_lockouts table is durable: upsert / get / clear under laundry_app GUC
    const lockUntil = clock.nowEpochSeconds() + 900;
    await store.pinLockouts.upsert({
      org_id: session.org_id,
      store_id: session.store_id,
      staff_id: DEMO_STAFF_A_ID,
      device_id: session.device_id,
      locked_until: lockUntil,
      failed_attempts: 5,
    });
    const locked = await store.pinLockouts.get(
      session.org_id,
      session.store_id,
      DEMO_STAFF_A_ID,
      session.device_id,
    );
    assert.ok(locked);
    assert.equal(locked.failed_attempts, 5);
    assert.equal(locked.locked_until, lockUntil);
    await store.pinLockouts.clear(
      session.org_id,
      session.store_id,
      DEMO_STAFF_A_ID,
      session.device_id,
    );
    assert.equal(
      await store.pinLockouts.get(
        session.org_id,
        session.store_id,
        DEMO_STAFF_A_ID,
        session.device_id,
      ),
      null,
    );

    // PIN switch revokes prior family — old refresh must fail closed
    const oldRefresh = await rotateRefresh(sessions, issued.refresh.refresh_token).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(oldRefresh);

    const switchedRefresh = await rotateRefresh(sessions, switched.refresh.refresh_token);
    assert.equal(switchedRefresh.session.staff_id, DEMO_STAFF_A_ID);

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
    void DEMO_ADMIN_ID;
  } finally {
    await adminPool.end();
    await appPool.end();
  }
});
