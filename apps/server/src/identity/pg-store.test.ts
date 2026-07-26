/**
 * PostgreSQL identity-store integration. The v2-integration workflow supplies
 * both explicit application and administrator database URLs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER } from "@laundry/contracts";

import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { createPgIdentityStore } from "./pg-store.js";
import { DEMO_STAFF_A_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { createPasswordPort } from "./password.js";
import { loginWithPassword } from "./login.js";
import { createAccessTokenSigner, hashOpaqueSecret } from "./crypto-util.js";
import { createQuickSwitchChallenge, verifyQuickSwitchPin } from "./pin.js";
import { rotateRefresh } from "./session.js";

// Ordinary unit runs stay database-free; v2-integration also supplies explicit URLs.
const pgOptIn =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true";
const urls = pgOptIn ? resolvePgUrls(process.env) : null;

const maybe = urls === null ? test.skip : test;

maybe("PG fixture supports login + PIN + refresh via laundry_app", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });
  try {
    const fixture = await seedPgTestIdentityFixture(adminPool);
    const store = createPgIdentityStore(appPool);
    const passwordPort = createPasswordPort();
    const clock = { nowEpochSeconds: () => Math.floor(Date.now() / 1000) };
    const sessions = {
      sessions: store.sessions,
      refresh: store.refresh,
      lifecycle: store.lifecycle,
      clock,
      accessTokenSigner: createAccessTokenSigner({
        secret: "pg-test-secret-32-byte-minimum-value",
        issuer: ACCESS_TOKEN_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
      }),
    };
    const loginDeps = {
      staff: store.staff,
      orgStore: store.orgStore,
      passwordPort,
      sessions,
    };
    const issued = await loginWithPassword(loginDeps, {
      org_code: LOCAL_PROFILE.orgCode,
      store_code: LOCAL_PROFILE.storeCode,
      username: fixture.adminUsername,
      password: fixture.adminPassword,
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
      pin: fixture.adminPin,
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

    const refreshedSwitch = await rotateRefresh(sessions, switched.refresh.refresh_token);
    assert.equal(refreshedSwitch.session.session_id, switched.session.session_id);

    const relogin = await loginWithPassword(loginDeps, {
      org_code: LOCAL_PROFILE.orgCode,
      store_code: LOCAL_PROFILE.storeCode,
      username: fixture.adminUsername,
      password: fixture.adminPassword,
      device_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    assert.notEqual(relogin.session.session_id, switched.session.session_id);
    assert.equal((await store.sessions.get(switched.session.session_id))?.status, "revoked");
    await assert.rejects(
      () => rotateRefresh(sessions, refreshedSwitch.refresh.refresh_token),
      /Authentication failed/u,
    );

    // Two application-pool connections serialize one active refresh use. The loser
    // observes reuse and revokes the session/family in the same transaction.
    const concurrent = await loginWithPassword(loginDeps, {
      org_code: LOCAL_PROFILE.orgCode,
      store_code: LOCAL_PROFILE.storeCode,
      username: fixture.adminUsername,
      password: fixture.adminPassword,
      device_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    const concurrentResults = await Promise.allSettled([
      rotateRefresh(sessions, concurrent.refresh.refresh_token),
      rotateRefresh(sessions, concurrent.refresh.refresh_token),
    ]);
    assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrentResults.filter((result) => result.status === "rejected").length, 1);
    const concurrentSession = await store.sessions.get(concurrent.session.session_id);
    assert.ok(concurrentSession);
    assert.equal(concurrentSession.status, "revoked");
    assert.equal((await store.refresh.getFamily(concurrentSession.family_id))?.status, "revoked");

    // An INSERT failure after the token CAS must roll the whole rotation back.
    const rollbackIssued = await loginWithPassword(loginDeps, {
      org_code: LOCAL_PROFILE.orgCode,
      store_code: LOCAL_PROFILE.storeCode,
      username: fixture.adminUsername,
      password: fixture.adminPassword,
      device_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    const rollbackSession = await store.sessions.get(rollbackIssued.session.session_id);
    assert.ok(rollbackSession);
    const rollbackFamily = await store.refresh.getFamily(rollbackSession.family_id);
    const rollbackToken = await store.refresh.getTokenByHash(
      hashOpaqueSecret(rollbackIssued.refresh.refresh_token),
    );
    assert.ok(rollbackFamily);
    assert.notEqual(rollbackToken.status, "unknown");
    if (rollbackToken.status === "unknown") assert.fail("expected active refresh token");
    await assert.rejects(() =>
      store.lifecycle.commitRefreshUse({
        session: rollbackSession,
        family: rollbackFamily,
        presented_token_id: rollbackToken.token_id,
        presented_token_hash: rollbackToken.token_hash,
        replacement_token: Object.freeze({
          status: "active" as const,
          token_id: rollbackToken.token_id,
          family_id: rollbackToken.family_id,
          session_id: rollbackToken.session_id,
          token_hash: hashOpaqueSecret(`rollback-${rollbackToken.token_id}`),
          expires_at: rollbackToken.expires_at,
        }),
        now: clock.nowEpochSeconds(),
      }),
    );
    assert.equal(
      (await store.refresh.getTokenByHash(hashOpaqueSecret(rollbackIssued.refresh.refresh_token)))
        .status,
      "active",
    );
    await rotateRefresh(sessions, rollbackIssued.refresh.refresh_token);

    // Reuse remains a credential-compromise signal even when staff authority drifts.
    const authorityIssued = await loginWithPassword(loginDeps, {
      org_code: LOCAL_PROFILE.orgCode,
      store_code: LOCAL_PROFILE.storeCode,
      username: fixture.adminUsername,
      password: fixture.adminPassword,
      device_id: "99999999-9999-4999-8999-999999999999",
    });
    await rotateRefresh(sessions, authorityIssued.refresh.refresh_token);
    await adminPool.query("UPDATE staffs SET is_active = false WHERE id = $1", [
      LOCAL_PROFILE.adminStaffId,
    ]);
    try {
      await assert.rejects(() => rotateRefresh(sessions, authorityIssued.refresh.refresh_token));
    } finally {
      await adminPool.query("UPDATE staffs SET is_active = true WHERE id = $1", [
        LOCAL_PROFILE.adminStaffId,
      ]);
    }
    const authoritySession = await store.sessions.get(authorityIssued.session.session_id);
    assert.ok(authoritySession);
    assert.equal(authoritySession.status, "revoked");
    assert.equal((await store.refresh.getFamily(authoritySession.family_id))?.status, "revoked");

    const bad = await loginWithPassword(loginDeps, {
      org_code: LOCAL_PROFILE.orgCode,
      store_code: LOCAL_PROFILE.storeCode,
      username: fixture.adminUsername,
      password: "wrong",
      device_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(bad);
  } finally {
    await adminPool.end();
    await appPool.end();
  }
});
