import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import test from "node:test";

import {
  EdgeAuthorityRequestSchema,
  canonicalizeEdgeDeviceRegistrationForSigning,
  type EdgeAuthorityChallengeData,
  type EdgeAuthorityChallengeRequest,
} from "@laundry/contracts";

import type { AuthorizedSession } from "../auth/session-view.js";
import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { createEdgeAuthorityService } from "./authority-service.js";
import { createPgAuthorityStore } from "./pg-authority-store.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

const DEVICE_A = "8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a81";
const DEVICE_B = "8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b82";

function session(deviceId: string): AuthorizedSession {
  return Object.freeze({
    session: Object.freeze({
      session_id: randomUUID(),
      session_version: 1,
      org_id: LOCAL_PROFILE.orgId,
      store_id: DEMO_STORE_ID,
      staff_id: DEMO_STAFF_A_ID,
      device_id: deviceId,
      permission_version: 1,
      authentication_method: "password",
      status: "active",
      family_id: randomUUID(),
      created_at: 1,
      revoked_at: null,
    }),
    authority: Object.freeze({
      staff_id: DEMO_STAFF_A_ID,
      display_name: "Fixture Admin",
      role: "admin",
      permission_version: 1,
      is_privacy_admin: false,
    }),
  });
}

function request(
  challenge: EdgeAuthorityChallengeData,
  challengeInput: EdgeAuthorityChallengeRequest,
  privateKey: KeyObject,
) {
  const authority = Object.freeze({
    protocol_version: "1.0.0",
    payload: Object.freeze({
      org_id: challenge.org_id,
      store_id: challenge.store_id,
      staff_id: challenge.staff_id,
      session_id: challenge.session_id,
      session_version: challenge.session_version,
      permission_version: challenge.permission_version,
      device_id: challenge.device_id,
      device_public_key_spki: challengeInput.device_public_key_spki,
      challenge_id: challenge.challenge_id,
      challenge: challenge.challenge,
      request_nonce: challengeInput.request_nonce,
      request_primary: challengeInput.request_primary,
      pairing_code: challenge.pairing_code,
    }),
  });
  return EdgeAuthorityRequestSchema.parse({
    ...authority,
    sig: sign(null, canonicalizeEdgeDeviceRegistrationForSigning(authority), privateKey).toString(
      "base64url",
    ),
  });
}

async function freshRequest(
  service: ReturnType<typeof createEdgeAuthorityService>,
  boundSession: AuthorizedSession,
  privateKey: KeyObject,
  publicKey: KeyObject,
) {
  const challengeInput = challengeInputFor(publicKey);
  const challenge = await service.challenge(boundSession, challengeInput);
  assert.ok(challenge);
  return request(challenge, challengeInput, privateKey);
}

function challengeInputFor(publicKey: KeyObject): EdgeAuthorityChallengeRequest {
  return Object.freeze({
    request_nonce: randomUUID(),
    device_public_key_spki: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    request_primary: true,
  });
}

async function clearAuthorityFixture(pool: PgPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    await client.query(
      `DELETE FROM audit_log
        WHERE org_id = $1::uuid AND store_id = $2::uuid
          AND command IN ('edge.device.pair', 'edge.primary.promote')
          AND device_id IN ($3::uuid, $4::uuid)`,
      [LOCAL_PROFILE.orgId, DEMO_STORE_ID, DEVICE_A, DEVICE_B],
    );
    for (const table of [
      "edge_replay_records",
      "primary_lease_replay_state",
      "primary_leases",
      "offline_grants",
      "primary_lease_heads",
      "edge_authority_challenges",
      "edge_devices",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE org_id = $1::uuid AND store_id = $2::uuid`, [
        LOCAL_PROFILE.orgId,
        DEMO_STORE_ID,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function expireCurrentLease(pool: PgPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    await client.query(
      `WITH trusted AS (SELECT clock_timestamp() AS now)
       UPDATE primary_leases
          SET issued_at = trusted.now - interval '10 seconds',
              ttl_ms = 1000,
              max_clock_skew_ms = 0,
              not_after = trusted.now - interval '9 seconds'
         FROM trusted
        WHERE org_id = $1::uuid AND store_id = $2::uuid
          AND id = (
            SELECT current_lease_id
              FROM primary_lease_heads
             WHERE org_id = $1::uuid AND store_id = $2::uuid
          )`,
      [LOCAL_PROFILE.orgId, DEMO_STORE_ID],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function waitForHeadLockWait(pool: PgPool): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ waiting: string }>(
      `SELECT count(*)::text AS waiting
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%SELECT current_epoch, current_lease_id%'`,
    );
    if (Number(result.rows[0]?.waiting ?? "0") > 0) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("Timed out waiting for authority head lock contention");
}

test(
  "real PG binds keys and serializes concurrent Primary issuance with its transaction clock",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app, max: 4 });
    try {
      await seedPgTestIdentityFixture(adminPool);
      await clearAuthorityFixture(adminPool);
      const service = createEdgeAuthorityService({
        store: createPgAuthorityStore(appPool),
        randomUUID,
        keyPair: generateKeyPairSync("ed25519"),
      });
      const keysA = generateKeyPairSync("ed25519");
      const keysB = generateKeyPairSync("ed25519");
      const sessionA = session(DEVICE_A);
      const sessionB = session(DEVICE_B);
      const requestA = await freshRequest(service, sessionA, keysA.privateKey, keysA.publicKey);
      const requestB = await freshRequest(service, sessionB, keysB.privateKey, keysB.publicKey);
      const [issuedA, issuedB] = await Promise.all([
        service.issue(sessionA, requestA),
        service.issue(sessionB, requestB),
      ]);
      const issued = [issuedA, issuedB].filter((value) => value !== null);
      assert.equal(issued.length, 1);
      assert.equal(issued[0]?.primary_lease?.payload.primary_epoch, 1);

      const persisted = await adminPool.query<{
        device_count: string;
        grant_count: string;
        lease_count: string;
        current_epoch: string;
        issued_at: Date;
      }>(
        `SELECT
           (SELECT count(*)::text FROM edge_devices
             WHERE org_id = $1::uuid AND store_id = $2::uuid) AS device_count,
           (SELECT count(*)::text FROM offline_grants
             WHERE org_id = $1::uuid AND store_id = $2::uuid) AS grant_count,
           (SELECT count(*)::text FROM primary_leases
             WHERE org_id = $1::uuid AND store_id = $2::uuid) AS lease_count,
           head.current_epoch::text,
           lease.issued_at
         FROM primary_lease_heads head
         JOIN primary_leases lease
           ON lease.org_id = head.org_id AND lease.store_id = head.store_id
          AND lease.id = head.current_lease_id
        WHERE head.org_id = $1::uuid AND head.store_id = $2::uuid`,
        [LOCAL_PROFILE.orgId, DEMO_STORE_ID],
      );
      assert.equal(persisted.rows[0]?.device_count, "1");
      assert.equal(persisted.rows[0]?.grant_count, "1");
      assert.equal(persisted.rows[0]?.lease_count, "1");
      assert.equal(persisted.rows[0]?.current_epoch, "1");
      assert.equal(
        persisted.rows[0]?.issued_at.toISOString(),
        issued[0]?.primary_lease.payload.issued_at,
      );
      const audit = await adminPool.query<{ command: string; after_json: string | null }>(
        `SELECT command, after_json
           FROM audit_log
          WHERE org_id = $1::uuid AND store_id = $2::uuid
            AND device_id = $3::uuid
            AND command IN ('edge.device.pair', 'edge.primary.promote')
          ORDER BY command`,
        [LOCAL_PROFILE.orgId, DEMO_STORE_ID, issuedA === null ? DEVICE_B : DEVICE_A],
      );
      assert.deepEqual(audit.rows, [
        { command: "edge.device.pair", after_json: '{"status":"paired"}' },
        { command: "edge.primary.promote", after_json: '{"status":"primary_promoted"}' },
      ]);

      const winnerSession = issuedA === null ? sessionB : sessionA;
      const winnerRequest = issuedA === null ? requestB : requestA;
      assert.equal(await service.issue(winnerSession, winnerRequest), null);

      await expireCurrentLease(adminPool);
      assert.equal(await service.issue(sessionA, requestA), null);
      assert.equal(await service.issue(sessionB, requestB), null);
      const rolloverRequestA = await freshRequest(
        service,
        sessionA,
        keysA.privateKey,
        keysA.publicKey,
      );
      const rolloverRequestB = await freshRequest(
        service,
        sessionB,
        keysB.privateKey,
        keysB.publicKey,
      );
      const headLocker = await adminPool.connect();
      type IssueResult = Awaited<ReturnType<typeof service.issue>>;
      let markerTime = Number.POSITIVE_INFINITY;
      let rolloverPromise: Promise<[IssueResult, IssueResult]> | undefined;
      try {
        await headLocker.query("BEGIN");
        await headLocker.query("SET LOCAL ROLE laundry_owner");
        await headLocker.query(
          `SELECT current_epoch
             FROM primary_lease_heads
            WHERE org_id = $1::uuid AND store_id = $2::uuid
            FOR UPDATE`,
          [LOCAL_PROFILE.orgId, DEMO_STORE_ID],
        );
        rolloverPromise = Promise.all([
          service.issue(sessionA, rolloverRequestA),
          service.issue(sessionB, rolloverRequestB),
        ]);
        await waitForHeadLockWait(adminPool);
        const marker = await headLocker.query<{ now: Date }>("SELECT clock_timestamp() AS now");
        markerTime = marker.rows[0]?.now.getTime() ?? Number.POSITIVE_INFINITY;
        await headLocker.query("COMMIT");
      } catch (error) {
        await headLocker.query("ROLLBACK");
        throw error;
      } finally {
        headLocker.release();
      }

      assert.ok(rolloverPromise);
      const [rolloverA, rolloverB] = await rolloverPromise;
      const rollover = [rolloverA, rolloverB].filter((value) => value !== null);
      assert.equal(rollover.length, 1);
      assert.equal(rollover[0]?.primary_lease?.payload.primary_epoch, 2);
      assert.ok(Date.parse(rollover[0]?.primary_lease?.payload.issued_at ?? "") >= markerTime);

      const rolloverWinnerDevice = rolloverA === null ? DEVICE_B : DEVICE_A;
      const rolloverWinnerSession = rolloverA === null ? sessionB : sessionA;
      const rolloverWinnerKeys = rolloverA === null ? keysB : keysA;
      await expireCurrentLease(adminPool);
      const replacement = generateKeyPairSync("ed25519");
      assert.equal(
        await service.challenge(rolloverWinnerSession, challengeInputFor(replacement.publicKey)),
        null,
      );
      const renewed = await service.issue(
        rolloverWinnerSession,
        await freshRequest(
          service,
          rolloverWinnerSession,
          rolloverWinnerKeys.privateKey,
          rolloverWinnerKeys.publicKey,
        ),
      );
      assert.notEqual(renewed, null);
      assert.equal(renewed?.primary_lease?.payload.primary_epoch, 3);
      const storedKey = await adminPool.query<{ public_key_spki: string }>(
        `SELECT public_key_spki
           FROM edge_devices
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid`,
        [LOCAL_PROFILE.orgId, DEMO_STORE_ID, rolloverWinnerDevice],
      );
      assert.equal(
        storedKey.rows[0]?.public_key_spki,
        rolloverWinnerKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      );
    } finally {
      await clearAuthorityFixture(adminPool);
      await appPool.end();
      await adminPool.end();
    }
  },
);
