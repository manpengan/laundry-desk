import { randomUUID } from "node:crypto";

import { withTransaction } from "./db.mjs";
import { verifyReleaseAck } from "./signing.mjs";
import { databaseTrustedClock } from "./trusted-clock.mjs";
import { validatePromotion, validateRelease } from "./validation.mjs";

async function lockHead(client, input) {
  const result = await client.query(
    `SELECT *, pg_backend_pid() AS backend_pid
     FROM primary_lease_heads
     WHERE org_id = $1 AND store_id = $2
     FOR UPDATE`,
    [input.org_id, input.store_id],
  );
  if (result.rowCount !== 1)
    throw new Error("primary lease head is not pre-created");
  return result.rows[0];
}

async function loadCurrentLease(client, head) {
  if (!head.current_lease_id) return undefined;
  const result = await client.query(
    "SELECT * FROM primary_leases WHERE lease_id = $1",
    [head.current_lease_id],
  );
  if (result.rowCount !== 1) throw new Error("head references a missing lease");
  return result.rows[0];
}

function eligibility(currentLease) {
  if (!currentLease || currentLease.released_at) return undefined;
  const eligibleAtMs =
    currentLease.not_after.getTime() + currentLease.max_clock_skew_ms;
  return new Date(eligibleAtMs);
}

function newLeasePayload(input, epoch, now) {
  return Object.freeze({
    lease_id: randomUUID(),
    store_id: input.store_id,
    device_id: input.device_id,
    primary_epoch: epoch,
    issued_at: now.toISOString(),
    ttl_ms: input.ttl_ms,
    max_clock_skew_ms: input.max_clock_skew_ms,
    not_after: new Date(now.getTime() + input.ttl_ms).toISOString(),
  });
}

async function persistLease(client, input, signedLease) {
  await client.query(
    `INSERT INTO primary_leases (
       org_id, store_id, device_id, lease_id, primary_epoch, issued_at,
       ttl_ms, max_clock_skew_ms, not_after, sig
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.org_id,
      input.store_id,
      input.device_id,
      signedLease.lease_id,
      signedLease.primary_epoch,
      signedLease.issued_at,
      signedLease.ttl_ms,
      signedLease.max_clock_skew_ms,
      signedLease.not_after,
      signedLease.sig,
    ],
  );
  await client.query(
    `UPDATE primary_lease_heads
     SET current_epoch = $3, current_lease_id = $4,
         current_not_after = $5, version = version + 1
     WHERE org_id = $1 AND store_id = $2`,
    [
      input.org_id,
      input.store_id,
      signedLease.primary_epoch,
      signedLease.lease_id,
      signedLease.not_after,
    ],
  );
}

async function promoteInTransaction(client, dependencies, input) {
  const head = await lockHead(client, input);
  const now = await dependencies.trustedClock.now(client);
  const currentLease = await loadCurrentLease(client, head);
  const eligibleAt = eligibility(currentLease);
  const diagnostics = Object.freeze({ backendPid: head.backend_pid });

  if (eligibleAt && now.getTime() < eligibleAt.getTime()) {
    return Object.freeze({
      status: "online-only",
      reason: "old-lease-wait",
      eligible_at: eligibleAt.toISOString(),
      diagnostics,
    });
  }

  const payload = newLeasePayload(input, Number(head.current_epoch) + 1, now);
  const signedLease = dependencies.signer.sign(payload);
  await persistLease(client, input, signedLease);
  return Object.freeze({ status: "issued", lease: signedLease, diagnostics });
}

async function releaseInTransaction(client, dependencies, input) {
  const head = await lockHead(client, input);
  const currentLease = await loadCurrentLease(client, head);
  if (!currentLease) throw new Error("no current lease to release");
  if (input.ack.lease_id !== currentLease.lease_id)
    throw new Error("release ACK lease mismatch");
  if (Number(input.ack.primary_epoch) !== Number(currentLease.primary_epoch)) {
    throw new Error("release ACK epoch mismatch");
  }
  if (input.ack.device_id !== currentLease.device_id) {
    throw new Error("release ACK device mismatch");
  }

  const publicKey = dependencies.getDevicePublicKey(currentLease.device_id);
  if (publicKey && typeof publicKey.then === "function") {
    throw new Error("device public key resolver must be synchronous");
  }
  if (!verifyReleaseAck(input.ack, publicKey))
    throw new Error("invalid release ACK signature");
  if (currentLease.released_at) return Object.freeze({ status: "released" });

  const now = await dependencies.trustedClock.now(client);
  await client.query(
    "UPDATE primary_leases SET released_at = $2 WHERE lease_id = $1",
    [currentLease.lease_id, now.toISOString()],
  );
  await client.query(
    `UPDATE primary_lease_heads SET version = version + 1
     WHERE org_id = $1 AND store_id = $2`,
    [input.org_id, input.store_id],
  );
  return Object.freeze({ status: "released", released_at: now.toISOString() });
}

export function createLeaseService(dependencies) {
  const runtime = Object.freeze({
    ...dependencies,
    trustedClock: dependencies.trustedClock ?? databaseTrustedClock,
  });
  return Object.freeze({
    promote(input) {
      validatePromotion(input);
      return withTransaction(runtime.pool, (client) =>
        promoteInTransaction(client, runtime, input),
      );
    },
    release(input) {
      validateRelease(input);
      return withTransaction(runtime.pool, (client) =>
        releaseInTransaction(client, runtime, input),
      );
    },
  });
}
