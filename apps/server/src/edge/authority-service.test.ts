import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import test from "node:test";
import {
  canonicalizeForSignatureVerification,
  createOfflineGrantRegistrySnapshot,
  parseServerSignatureOfflineGrantCandidate,
} from "@laundry/contracts";

import type { AuthorizedSession } from "../auth/session-view.js";
import { createEdgeAuthorityService } from "./authority-service.js";

const ORG_ID = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STORE_ID = "11a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STAFF_ID = "21a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const DEVICE_ID = "31a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const OTHER_DEVICE_ID = "41a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const IDS = [
  "51a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  "61a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  "71a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  "81a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  "91a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  "a1a2eed0-a6c3-493c-a3a7-20bf94b1d678",
];

function session(deviceId = DEVICE_ID): AuthorizedSession {
  return Object.freeze({
    session: Object.freeze({
      session_id: "b1a2eed0-a6c3-493c-a3a7-20bf94b1d678",
      session_version: 1,
      org_id: ORG_ID,
      store_id: STORE_ID,
      staff_id: STAFF_ID,
      device_id: deviceId,
      permission_version: 4,
      authentication_method: "password",
      status: "active",
      family_id: "c1a2eed0-a6c3-493c-a3a7-20bf94b1d678",
      created_at: 1,
      revoked_at: null,
    }),
    authority: Object.freeze({
      staff_id: STAFF_ID,
      display_name: "Staff",
      role: "staff",
      permission_version: 4,
      is_privacy_admin: false,
    }),
  });
}

test("issues verifiable staff/device-bound grant and exclusive Primary Lease", () => {
  let now = Date.parse("2026-07-30T01:02:03.000Z");
  const ids = [...IDS];
  const service = createEdgeAuthorityService({
    now: () => now,
    randomUUID: () => ids.shift()!,
  });
  const first = service.issue(session());
  assert.notEqual(first, null);
  if (first === null) return;
  assert.equal(first.offline_grant.payload.permission_version, 4);
  assert.equal(first.primary_lease.payload.device_id, DEVICE_ID);
  assert.equal(service.issue(session(OTHER_DEVICE_ID)), null);

  const publicKey = createPublicKey({
    key: Buffer.from(first.server_public_key_spki, "base64"),
    format: "der",
    type: "spki",
  });
  const candidate = parseServerSignatureOfflineGrantCandidate(
    first.offline_grant,
    createOfflineGrantRegistrySnapshot(),
  );
  assert.equal(
    verify(
      null,
      canonicalizeForSignatureVerification(candidate),
      publicKey,
      Buffer.from(candidate.sig, "base64url"),
    ),
    true,
  );

  now += 60_001;
  const takeover = service.issue(session(OTHER_DEVICE_ID));
  assert.notEqual(takeover, null);
  assert.notEqual(
    takeover?.primary_lease.payload.primary_epoch,
    first.primary_lease.payload.primary_epoch,
  );
});
