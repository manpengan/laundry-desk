import { timingSafeEqual } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient } from "../db/types.js";
import type {
  AuthorityStoreChallengeInput,
  AuthorityStoreIssueInput,
  AuthorityStoreIssueResult,
  EdgeAuthorityStore,
  SignedPrimaryLease,
} from "./authority-store.js";
import {
  consumePgAuthorityChallenge,
  createPgAuthorityChallenge,
  type ConsumedAuthorityChallenge,
} from "./pg-authority-challenge-store.js";
import {
  appendPgAuthorityAudit,
  bindPgAuthorityDevice,
  loadPgPrimaryLease,
  lockPgAuthorityDevice,
  lockPgPrimaryHead,
  parseAuthorityInteger,
  persistPgOfflineGrant,
  persistPgPrimaryLease,
  pgAuthorityDeviceMatches,
  readAuthorityDatabaseNow,
} from "./pg-authority-persistence.js";

function validPairingProof(
  input: AuthorityStoreIssueInput,
  challenge: ConsumedAuthorityChallenge,
): boolean {
  if (!challenge.pairingCodeRequired) return input.pairingCodeHash === null;
  if (
    !input.canPairDevice ||
    challenge.pairingCodeHash === null ||
    input.pairingCodeHash === null ||
    !/^[0-9a-f]{64}$/u.test(challenge.pairingCodeHash) ||
    !/^[0-9a-f]{64}$/u.test(input.pairingCodeHash)
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(challenge.pairingCodeHash, "hex"),
    Buffer.from(input.pairingCodeHash, "hex"),
  );
}

async function issueInTransaction(
  client: SqlClient,
  input: AuthorityStoreIssueInput,
): Promise<AuthorityStoreIssueResult | null> {
  const challenge = await consumePgAuthorityChallenge(client, input);
  if (challenge === null || !validPairingProof(input, challenge)) return null;
  const existingDevice = await lockPgAuthorityDevice(client, input);
  if (
    existingDevice === null
      ? !challenge.pairingCodeRequired
      : !pgAuthorityDeviceMatches(input, existingDevice)
  ) {
    return null;
  }
  // Trusted time is read after any Primary head lock below. A queued promoter
  // must never decide expiry from a timestamp captured before serialization.
  let now = await readAuthorityDatabaseNow(client);
  let nextEpoch: number | null = null;
  if (input.requestPrimary) {
    const head = await lockPgPrimaryHead(client, input);
    now = await readAuthorityDatabaseNow(client);
    const currentEpoch = parseAuthorityInteger(head.current_epoch, "head epoch");
    if (
      !input.canPromotePrimary ||
      challenge.expectedPrimaryEpoch === null ||
      currentEpoch !== challenge.expectedPrimaryEpoch
    ) {
      return null;
    }
    if (head.current_lease_id !== null) {
      const current = await loadPgPrimaryLease(client, input, head.current_lease_id);
      const eligibleAt = Date.parse(current.payload.not_after) + current.payload.max_clock_skew_ms;
      if (now.getTime() < eligibleAt) return null;
    }
    nextEpoch = currentEpoch + 1;
  }

  const firstPair = await bindPgAuthorityDevice(client, input, existingDevice);
  const offlineGrant = input.createGrant(now);
  await persistPgOfflineGrant(client, input, offlineGrant);
  if (firstPair) {
    await appendPgAuthorityAudit(client, input, now, "edge.device.pair");
  }
  let primaryLease: SignedPrimaryLease | null = null;
  if (nextEpoch !== null) {
    primaryLease = input.createLease(now, nextEpoch, offlineGrant.payload.grant_id);
    await persistPgPrimaryLease(
      client,
      input,
      primaryLease,
      nextEpoch,
      offlineGrant.payload.grant_id,
    );
    await appendPgAuthorityAudit(client, input, now, "edge.primary.promote");
  }
  return Object.freeze({ offlineGrant, primaryLease });
}

export function createPgAuthorityStore(pool: PgPool): EdgeAuthorityStore {
  return Object.freeze({
    createChallenge: (input: AuthorityStoreChallengeInput) =>
      withPoolClient(pool, (client) =>
        withTenantTransaction(
          client,
          { orgId: input.orgId, storeId: input.storeId, staffId: input.staffId },
          (tx) => createPgAuthorityChallenge(tx, input),
        ),
      ),
    issue: (input: AuthorityStoreIssueInput) =>
      withPoolClient(pool, (client) =>
        withTenantTransaction(
          client,
          { orgId: input.orgId, storeId: input.storeId, staffId: input.staffId },
          (tx) => issueInTransaction(tx, input),
        ),
      ),
  });
}
