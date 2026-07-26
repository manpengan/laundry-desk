/**
 * PostgreSQL identity-store integration. The v2-integration workflow supplies
 * both explicit application and administrator database URLs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER } from "@laundry/contracts";

import { createCsrfProofSigner } from "../auth/csrf.js";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { createPgIdentityStore } from "./pg-store.js";
import { DEMO_STAFF_A_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { createPasswordPort } from "./password.js";
import { loginWithPassword } from "./login.js";
import { createAccessTokenSigner, hashOpaqueSecret } from "./crypto-util.js";
import { createQuickSwitchChallenge, verifyQuickSwitchPin } from "./pin.js";
import { logoutSession, rotateRefresh } from "./session.js";
import { IdentityError } from "./types.js";

// Ordinary unit runs stay database-free; v2-integration also supplies explicit URLs.
const pgOptIn =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true";
const urls = pgOptIn ? resolvePgUrls(process.env) : null;

const maybe = urls === null ? test.skip : test;

const PIN_AUDIT_FAILURE_TRIGGER = "pin_lockout_audit_failure";
const PIN_AUDIT_FAILURE_FUNCTION = "fail_pin_lockout_audit";
const PIN_AUDIT_ROLLBACK_DEVICE = "34343434-3434-4434-8434-343434343434";

async function installPinAuditFailureTrigger(
  adminPool: ReturnType<typeof createPgPool>,
): Promise<void> {
  await adminPool.query(`DROP TRIGGER IF EXISTS ${PIN_AUDIT_FAILURE_TRIGGER} ON audit_log`);
  await adminPool.query(`
    CREATE OR REPLACE FUNCTION ${PIN_AUDIT_FAILURE_FUNCTION}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.command = 'identity.pin.locked'
         AND NEW.device_id = '${PIN_AUDIT_ROLLBACK_DEVICE}'::uuid THEN
        RAISE EXCEPTION 'forced pin lockout audit failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await adminPool.query(
    `CREATE TRIGGER ${PIN_AUDIT_FAILURE_TRIGGER}
     BEFORE INSERT ON audit_log
     FOR EACH ROW EXECUTE FUNCTION ${PIN_AUDIT_FAILURE_FUNCTION}()`,
  );
}

async function removePinAuditFailureTrigger(
  adminPool: ReturnType<typeof createPgPool>,
): Promise<void> {
  await adminPool.query(`DROP TRIGGER IF EXISTS ${PIN_AUDIT_FAILURE_TRIGGER} ON audit_log`);
  await adminPool.query(`DROP FUNCTION IF EXISTS ${PIN_AUDIT_FAILURE_FUNCTION}()`);
}

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
      csrfProofMinter: createCsrfProofSigner("pg-test-csrf-secret-32-byte-minimum"),
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
    const issuePinSession = async (deviceId: string) => {
      const isolated = await loginWithPassword(loginDeps, {
        org_code: LOCAL_PROFILE.orgCode,
        store_code: LOCAL_PROFILE.storeCode,
        username: fixture.adminUsername,
        password: fixture.adminPassword,
        device_id: deviceId,
      });
      const isolatedSession = await store.sessions.get(isolated.session.session_id);
      assert.ok(isolatedSession);
      await store.pinLockouts.clear(
        isolatedSession.org_id,
        isolatedSession.store_id,
        DEMO_STAFF_A_ID,
        deviceId,
      );
      return isolatedSession;
    };
    const verifyWrongPin = (challengeId: string, boundSession: typeof session) =>
      verifyQuickSwitchPin(pinDeps, {
        challenge_id: challengeId,
        pin: `${fixture.adminPin}-wrong`,
        session: boundSession,
      });
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
      last_failed_at: clock.nowEpochSeconds(),
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

    // Two first failures on different challenges race the initially absent
    // pin_lockouts row; the device advisory lock preserves both increments.
    const firstRowDeviceId = "56565656-5656-4656-8656-565656565656";
    const firstRowSession = await issuePinSession(firstRowDeviceId);
    const firstRowChallengeA = await createQuickSwitchChallenge(pinDeps, {
      purpose: "quick_switch",
      session: firstRowSession,
      target_staff_id: DEMO_STAFF_A_ID,
    });
    const firstRowChallengeB = await createQuickSwitchChallenge(pinDeps, {
      purpose: "quick_switch",
      session: firstRowSession,
      target_staff_id: DEMO_STAFF_A_ID,
    });
    const firstRowResults = await Promise.allSettled([
      verifyWrongPin(firstRowChallengeA.challenge_id, firstRowSession),
      verifyWrongPin(firstRowChallengeB.challenge_id, firstRowSession),
    ]);
    assert.equal(
      firstRowResults.every(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof IdentityError &&
          result.reason.code === "AUTHENTICATION_FAILED",
      ),
      true,
    );
    const firstRowLockout = await store.pinLockouts.get(
      firstRowSession.org_id,
      firstRowSession.store_id,
      DEMO_STAFF_A_ID,
      firstRowDeviceId,
    );
    assert.equal(firstRowLockout?.failed_attempts, 2);

    // A successful atomic consume clears a partial cumulative counter while
    // using the database-derived requester as the transaction actor.
    const clearDeviceId = "67676767-6767-4767-8767-676767676767";
    const clearSession = await issuePinSession(clearDeviceId);
    const clearChallenge = await createQuickSwitchChallenge(pinDeps, {
      purpose: "quick_switch",
      session: clearSession,
      target_staff_id: DEMO_STAFF_A_ID,
    });
    await assert.rejects(() => verifyWrongPin(clearChallenge.challenge_id, clearSession));
    assert.equal(
      (
        await store.pinLockouts.get(
          clearSession.org_id,
          clearSession.store_id,
          DEMO_STAFF_A_ID,
          clearDeviceId,
        )
      )?.failed_attempts,
      1,
    );
    assert.equal(
      await store.pinChallenges.consumeSuccess({
        challenge_id: clearChallenge.challenge_id,
        org_id: clearSession.org_id,
        store_id: clearSession.store_id,
        staff_id: DEMO_STAFF_A_ID,
        device_id: clearDeviceId,
        expected_failed_attempts: 1,
        attempted_at: clock.nowEpochSeconds(),
      }),
      1,
    );
    assert.equal(
      await store.pinLockouts.get(
        clearSession.org_id,
        clearSession.store_id,
        DEMO_STAFF_A_ID,
        clearDeviceId,
      ),
      null,
    );

    // After four failures, two different challenges race the fifth slot.
    const concurrentFifthDeviceId = "78787878-7878-4878-8878-787878787878";
    const concurrentFifthSession = await issuePinSession(concurrentFifthDeviceId);
    const cumulativeSeedChallenge = await createQuickSwitchChallenge(pinDeps, {
      purpose: "quick_switch",
      session: concurrentFifthSession,
      target_staff_id: DEMO_STAFF_A_ID,
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assert.rejects(() =>
        verifyWrongPin(cumulativeSeedChallenge.challenge_id, concurrentFifthSession),
      );
    }
    const concurrentFifthA = await createQuickSwitchChallenge(pinDeps, {
      purpose: "quick_switch",
      session: concurrentFifthSession,
      target_staff_id: DEMO_STAFF_A_ID,
    });
    const concurrentFifthB = await createQuickSwitchChallenge(pinDeps, {
      purpose: "quick_switch",
      session: concurrentFifthSession,
      target_staff_id: DEMO_STAFF_A_ID,
    });
    const concurrentFifthResults = await Promise.allSettled([
      verifyWrongPin(concurrentFifthA.challenge_id, concurrentFifthSession),
      verifyWrongPin(concurrentFifthB.challenge_id, concurrentFifthSession),
    ]);
    const concurrentFifthCodes = concurrentFifthResults
      .map((result) => (result.status === "rejected" ? result.reason : null))
      .filter((error): error is IdentityError => error instanceof IdentityError)
      .map((error) => error.code)
      .sort();
    assert.deepEqual(concurrentFifthCodes, ["AUTHENTICATION_FAILED", "PIN_LOCKED"]);
    assert.equal(
      (
        await store.pinLockouts.get(
          concurrentFifthSession.org_id,
          concurrentFifthSession.store_id,
          DEMO_STAFF_A_ID,
          concurrentFifthDeviceId,
        )
      )?.failed_attempts,
      5,
    );

    // Failed PINs accumulate across distinct challenges for the same
    // org/store/staff/device and the fifth failure locks the target.
    const cumulativeDeviceId = "12121212-1212-4212-8212-121212121212";
    const cumulativeIssued = await loginWithPassword(loginDeps, {
      org_code: LOCAL_PROFILE.orgCode,
      store_code: LOCAL_PROFILE.storeCode,
      username: fixture.adminUsername,
      password: fixture.adminPassword,
      device_id: cumulativeDeviceId,
    });
    const cumulativeSession = await store.sessions.get(cumulativeIssued.session.session_id);
    assert.ok(cumulativeSession);
    await store.pinLockouts.clear(
      cumulativeSession.org_id,
      cumulativeSession.store_id,
      DEMO_STAFF_A_ID,
      cumulativeDeviceId,
    );
    const cumulativeChallengeA = await createQuickSwitchChallenge(pinDeps, {
      purpose: "quick_switch",
      session: cumulativeSession,
      target_staff_id: DEMO_STAFF_A_ID,
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assert.rejects(() =>
        verifyQuickSwitchPin(pinDeps, {
          challenge_id: cumulativeChallengeA.challenge_id,
          pin: `${fixture.adminPin}-wrong`,
          session: cumulativeSession,
        }),
      );
    }
    const cumulativeChallengeB = await createQuickSwitchChallenge(pinDeps, {
      purpose: "quick_switch",
      session: cumulativeSession,
      target_staff_id: DEMO_STAFF_A_ID,
    });
    const cumulativeAuditBefore = await adminPool.query<{ id: string }>(
      `SELECT id::text
         FROM audit_log
        WHERE command = 'identity.pin.locked'
          AND entity_id = $1
          AND device_id = $2::uuid`,
      [DEMO_STAFF_A_ID, cumulativeDeviceId],
    );
    const cumulativeAuditIdsBefore = new Set(cumulativeAuditBefore.rows.map((row) => row.id));
    await assert.rejects(() =>
      verifyQuickSwitchPin(pinDeps, {
        challenge_id: cumulativeChallengeB.challenge_id,
        pin: `${fixture.adminPin}-wrong`,
        session: cumulativeSession,
      }),
    );
    const cumulativeLockout = await store.pinLockouts.get(
      cumulativeSession.org_id,
      cumulativeSession.store_id,
      DEMO_STAFF_A_ID,
      cumulativeDeviceId,
    );
    assert.equal(cumulativeLockout?.failed_attempts, 5);
    assert.ok((cumulativeLockout?.locked_until ?? 0) > clock.nowEpochSeconds());
    const cumulativeAudit = await adminPool.query<{
      id: string;
      command: string;
      entity: string;
      entity_id: string;
      after_json: string;
      device_id: string;
      staff_id: string;
    }>(
      `SELECT id::text, command, entity, entity_id, after_json, device_id::text,
              staff_id::text
         FROM audit_log
        WHERE command = 'identity.pin.locked'
          AND entity_id = $1
          AND device_id = $2::uuid`,
      [DEMO_STAFF_A_ID, cumulativeDeviceId],
    );
    const newCumulativeAudits = cumulativeAudit.rows.filter(
      (row) => !cumulativeAuditIdsBefore.has(row.id),
    );
    assert.equal(newCumulativeAudits.length, 1);
    assert.deepEqual(newCumulativeAudits[0], {
      id: newCumulativeAudits[0]?.id,
      command: "identity.pin.locked",
      entity: "staff",
      entity_id: DEMO_STAFF_A_ID,
      after_json: '{"lockout":"active","reason":"failed_pin_threshold"}',
      device_id: cumulativeDeviceId,
      staff_id: LOCAL_PROFILE.adminStaffId,
    });
    await assert.rejects(
      () =>
        createQuickSwitchChallenge(pinDeps, {
          purpose: "quick_switch",
          session: cumulativeSession,
          target_staff_id: DEMO_STAFF_A_ID,
        }),
      (error: unknown) => {
        assert.ok(error instanceof IdentityError);
        assert.equal(error.code, "PIN_LOCKED");
        return true;
      },
    );

    // An audit INSERT failure rolls back both the fifth challenge attempt and
    // the cumulative lockout transition from four failures to five.
    const pinAuditRollbackIssued = await loginWithPassword(loginDeps, {
      org_code: LOCAL_PROFILE.orgCode,
      store_code: LOCAL_PROFILE.storeCode,
      username: fixture.adminUsername,
      password: fixture.adminPassword,
      device_id: PIN_AUDIT_ROLLBACK_DEVICE,
    });
    const rollbackPinSession = await store.sessions.get(pinAuditRollbackIssued.session.session_id);
    assert.ok(rollbackPinSession);
    await store.pinLockouts.clear(
      rollbackPinSession.org_id,
      rollbackPinSession.store_id,
      DEMO_STAFF_A_ID,
      PIN_AUDIT_ROLLBACK_DEVICE,
    );
    const rollbackChallengeA = await createQuickSwitchChallenge(pinDeps, {
      purpose: "quick_switch",
      session: rollbackPinSession,
      target_staff_id: DEMO_STAFF_A_ID,
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assert.rejects(() =>
        verifyQuickSwitchPin(pinDeps, {
          challenge_id: rollbackChallengeA.challenge_id,
          pin: `${fixture.adminPin}-wrong`,
          session: rollbackPinSession,
        }),
      );
    }
    const rollbackChallengeB = await createQuickSwitchChallenge(pinDeps, {
      purpose: "quick_switch",
      session: rollbackPinSession,
      target_staff_id: DEMO_STAFF_A_ID,
    });
    const rollbackLockoutBefore = await store.pinLockouts.get(
      rollbackPinSession.org_id,
      rollbackPinSession.store_id,
      DEMO_STAFF_A_ID,
      PIN_AUDIT_ROLLBACK_DEVICE,
    );
    const rollbackChallengeBefore = await store.pinChallenges.get(rollbackChallengeB.challenge_id);
    const rollbackAuditBefore = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE command = 'identity.pin.locked'
          AND device_id = $1::uuid`,
      [PIN_AUDIT_ROLLBACK_DEVICE],
    );
    assert.ok(rollbackLockoutBefore);
    assert.ok(rollbackChallengeBefore);
    await installPinAuditFailureTrigger(adminPool);
    try {
      await assert.rejects(
        () =>
          verifyQuickSwitchPin(pinDeps, {
            challenge_id: rollbackChallengeB.challenge_id,
            pin: `${fixture.adminPin}-wrong`,
            session: rollbackPinSession,
          }),
        /forced pin lockout audit failure/u,
      );
    } finally {
      await removePinAuditFailureTrigger(adminPool);
    }
    const rollbackLockoutAfter = await store.pinLockouts.get(
      rollbackPinSession.org_id,
      rollbackPinSession.store_id,
      DEMO_STAFF_A_ID,
      PIN_AUDIT_ROLLBACK_DEVICE,
    );
    assert.deepEqual(rollbackLockoutAfter, rollbackLockoutBefore);
    const rollbackChallengeAfter = await store.pinChallenges.get(rollbackChallengeB.challenge_id);
    assert.deepEqual(rollbackChallengeAfter, rollbackChallengeBefore);
    const rollbackAuditAfter = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE command = 'identity.pin.locked'
          AND device_id = $1::uuid`,
      [PIN_AUDIT_ROLLBACK_DEVICE],
    );
    assert.equal(rollbackAuditAfter.rows[0]?.count, rollbackAuditBefore.rows[0]?.count);

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
    const reuseAudit = await adminPool.query<{
      command: string;
      entity: string;
      entity_id: string;
      after_json: string;
    }>(
      `SELECT command, entity, entity_id, after_json
         FROM audit_log
        WHERE command = 'identity.refresh.reuse_revoked'
          AND entity_id = $1`,
      [concurrent.session.session_id],
    );
    assert.deepEqual(reuseAudit.rows, [
      {
        command: "identity.refresh.reuse_revoked",
        entity: "session",
        entity_id: concurrent.session.session_id,
        after_json: '{"family_status":"revoked","session_status":"revoked"}',
      },
    ]);

    const logoutIssued = await loginWithPassword(loginDeps, {
      org_code: LOCAL_PROFILE.orgCode,
      store_code: LOCAL_PROFILE.storeCode,
      username: fixture.adminUsername,
      password: fixture.adminPassword,
      device_id: "77777777-7777-4777-8777-777777777777",
    });
    const logoutSessionRecord = await store.sessions.get(logoutIssued.session.session_id);
    assert.ok(logoutSessionRecord);
    await logoutSession(sessions, {
      org_id: logoutIssued.session.org_id,
      store_id: logoutIssued.session.store_id,
      staff_id: logoutIssued.session.staff_id,
      device_id: logoutIssued.session.device_id,
      session_id: logoutIssued.session.session_id,
      family_id: logoutSessionRecord.family_id,
      session_version: logoutIssued.session.session_version,
    });
    const logoutAudit = await adminPool.query<{
      command: string;
      entity_id: string;
      after_json: string;
    }>(
      `SELECT command, entity_id, after_json
         FROM audit_log
        WHERE command = 'identity.logout'
          AND entity_id = $1`,
      [logoutIssued.session.session_id],
    );
    assert.deepEqual(logoutAudit.rows, [
      {
        command: "identity.logout",
        entity_id: logoutIssued.session.session_id,
        after_json: '{"family_status":"revoked","session_status":"revoked"}',
      },
    ]);

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
