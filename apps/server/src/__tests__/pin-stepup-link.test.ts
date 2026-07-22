/**
 * Step-up PIN ↔ pending confirm_ref: second staff PIN then creator resume.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createDefaultChainHooks } from "../handlers/default-chain-hooks.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { createAccessTokenSigner } from "../identity/crypto-util.js";
import { createMemoryIdentityStore } from "../identity/memory-store.js";
import { createTestPasswordPort } from "../identity/password.js";
import { createStepUpChallenge, verifyStepUpPin } from "../identity/pin-step-up.js";
import { issueSession } from "../identity/session.js";
import type { StaffRecord } from "../identity/types.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";
import { MemoryStepUpProofStore } from "../policy/step-up-proof-store.js";

const DEVICE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DEMO_PIN = "1234";
const ADMIN_PIN = "5678";

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

const STAFF: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: DEVICE_ID,
  via: "ui" as const,
  permissions: Object.freeze(["settings_admin", "staff_read"]),
});

async function seedIdentity() {
  const store = createMemoryIdentityStore();
  const passwordPort = createTestPasswordPort();
  const passwordHash = await passwordPort.hashPassword("demo");
  const staffPin = await passwordPort.hashPassword(DEMO_PIN);
  const adminPin = await passwordPort.hashPassword(ADMIN_PIN);
  const clock = { nowEpochSeconds: () => Math.floor(Date.now() / 1000) };

  store.seedOrgStore({
    org_id: DEMO_ORG_ID,
    org_code: "hongfa",
    store_id: DEMO_STORE_ID,
    store_code: "main",
  });

  const seed = (staffId: string, username: string, pinHash: string): void => {
    const staff: StaffRecord = Object.freeze({
      staff_id: staffId,
      org_id: DEMO_ORG_ID,
      username,
      password_hash: passwordHash,
      pin_hash: pinHash,
      display_name: username,
      is_active: true,
      permission_version: 1,
    });
    store.seedStaff(staff);
  };
  seed(DEMO_STAFF_A_ID, "staff", staffPin);
  seed(DEMO_ADMIN_ID, "admin", adminPin);

  const sessionDeps = {
    sessions: store.sessions,
    refresh: store.refresh,
    clock,
    accessTokenSigner: createAccessTokenSigner("test-secret"),
  };

  const pendingStore = new MemoryPendingActionStore();
  const proofStore = new MemoryStepUpProofStore();
  const pin = {
    challenges: store.pinChallenges,
    lockouts: store.pinLockouts,
    staff: store.staff,
    pinPort: passwordPort,
    clock,
    sessions: sessionDeps,
  };
  const pinStepUp = Object.freeze({
    ...pin,
    pending: pendingStore,
    proofs: proofStore,
  });

  const issued = await issueSession(sessionDeps, {
    org_id: DEMO_ORG_ID,
    store_id: DEMO_STORE_ID,
    staff_id: DEMO_STAFF_A_ID,
    device_id: DEVICE_ID,
    permission_version: 1,
    authentication_method: "password",
  });
  const session = await store.sessions.get(issued.session.session_id);
  assert.ok(session);

  return { store, pinStepUp, pendingStore, proofStore, session, passwordPort };
}

function buildBus(pendingStore: MemoryPendingActionStore) {
  const settings = createMemorySettingsStore();
  const { registry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings,
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
  });
  const chainHooks = createDefaultChainHooks({}, pendingStore);
  return { registry, chainHooks, settings };
}

test("step-up PIN binds real pending args_hash then creator confirm_ref resumes", async () => {
  const { pinStepUp, pendingStore, proofStore, session } = await seedIdentity();
  const { registry, chainHooks, settings } = buildBus(pendingStore);

  // Staff triggers R5 → blocked with confirm_ref
  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "platform.settings.set",
    {
      entries: [{ key: "pricing.min_order_cents", value_json: "2100" }],
    },
    {
      registry,
      actor: STAFF,
      chainHooks,
      pendingStore,
      stepUpProofStore: proofStore,
    },
  );
  assert.equal(first.ok, false);
  const detail = !first.ok && "detail" in first.error ? first.error.detail : undefined;
  if (detail?.kind !== "confirmation") {
    assert.fail("expected step-up confirmation detail");
  }
  const confirmRef = detail.confirm_ref;
  const pending = pendingStore.get(confirmRef);
  assert.ok(pending);
  assert.equal(pending.requiresOtherApprover, true);

  // Creator session requests step-up PIN challenge for admin approver
  const challenge = await createStepUpChallenge(pinStepUp, {
    purpose: "step_up",
    session,
    pending_action_ref: confirmRef,
    approver_staff_id: DEMO_ADMIN_ID,
  });
  assert.equal(challenge.purpose, "step_up");
  assert.match(challenge.challenge_id, /^[0-9a-f-]{36}$/i);

  // Challenge must freeze the same args_hash as the pending card
  const stored = (await pinStepUp.challenges.get(challenge.challenge_id))!;
  assert.equal(stored.args_hash, pending.argsHash);
  assert.equal(stored.pending_action_ref, confirmRef);
  assert.equal(stored.approver_staff_id, DEMO_ADMIN_ID);

  // Wrong PIN fails closed (session stays creator)
  await assert.rejects(
    () =>
      verifyStepUpPin(pinStepUp, {
        challenge_id: challenge.challenge_id,
        pin: "0000",
        session,
      }),
    (err: unknown) => {
      assert.ok(err && typeof err === "object" && "code" in err);
      return true;
    },
  );

  // Fresh challenge after failed attempt still open (1 fail)
  const challenge2 = await createStepUpChallenge(pinStepUp, {
    purpose: "step_up",
    session,
    pending_action_ref: confirmRef,
    approver_staff_id: DEMO_ADMIN_ID,
  });

  // Admin PIN success → proof, no session switch
  const proof = await verifyStepUpPin(pinStepUp, {
    challenge_id: challenge2.challenge_id,
    pin: ADMIN_PIN,
    session,
  });
  assert.match(proof.step_up_proof_id, /^[0-9a-f-]{36}$/i);
  assert.ok(proofStore.get(proof.step_up_proof_id));
  assert.equal(session.staff_id, DEMO_STAFF_A_ID);

  // Self confirm without proof would still fail — but we have proof
  const resumed = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "platform.settings.set",
    { entries: [{ key: "pricing.min_order_cents", value_json: "9999" }] },
    {
      registry,
      actor: STAFF,
      chainHooks,
      pendingStore,
      stepUpProofStore: proofStore,
      confirmRef,
    },
  );
  assert.equal(resumed.ok, true, JSON.stringify(resumed));

  // WYSIWYS: frozen 2100 wins
  const values = await settings.getMany(["pricing.min_order_cents"]);
  assert.equal(values["pricing.min_order_cents"], "2100");

  // Proof and card are single-use
  assert.equal(proofStore.get(proof.step_up_proof_id)?.status, "consumed");
  const again = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "platform.settings.set",
    {},
    {
      registry,
      actor: STAFF,
      chainHooks,
      pendingStore,
      stepUpProofStore: proofStore,
      confirmRef,
    },
  );
  assert.equal(again.ok, false);
});

test("step-up challenge rejects self-approver and non-creator session", async () => {
  const { pinStepUp, pendingStore, session, store } = await seedIdentity();
  const { registry, chainHooks } = buildBus(pendingStore);

  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "platform.settings.set",
    {
      entries: [{ key: "pricing.min_order_cents", value_json: "2200" }],
    },
    { registry, actor: STAFF, chainHooks, pendingStore },
  );
  assert.equal(first.ok, false);
  const detail = !first.ok && "detail" in first.error ? first.error.detail : undefined;
  if (detail?.kind !== "confirmation") assert.fail("expected confirm_ref");
  const confirmRef = detail.confirm_ref;

  await assert.rejects(() =>
    createStepUpChallenge(pinStepUp, {
      purpose: "step_up",
      session,
      pending_action_ref: confirmRef,
      approver_staff_id: DEMO_STAFF_A_ID,
    }),
  );

  // Admin session cannot open challenge for staff's pending card
  const adminIssued = await issueSession(
    {
      sessions: store.sessions,
      refresh: store.refresh,
      clock: pinStepUp.clock,
      accessTokenSigner: createAccessTokenSigner("test-secret"),
    },
    {
      org_id: DEMO_ORG_ID,
      store_id: DEMO_STORE_ID,
      staff_id: DEMO_ADMIN_ID,
      device_id: DEVICE_ID,
      permission_version: 1,
      authentication_method: "password",
    },
  );
  const adminSession = await store.sessions.get(adminIssued.session.session_id);
  assert.ok(adminSession);

  await assert.rejects(() =>
    createStepUpChallenge(pinStepUp, {
      purpose: "step_up",
      session: adminSession,
      pending_action_ref: confirmRef,
      approver_staff_id: DEMO_ADMIN_ID,
    }),
  );
});

test("creator confirm_ref without step-up proof still denied", async () => {
  const pendingStore = new MemoryPendingActionStore();
  const proofStore = new MemoryStepUpProofStore();
  const { registry, chainHooks } = buildBus(pendingStore);

  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "platform.settings.set",
    {
      entries: [{ key: "pricing.min_order_cents", value_json: "2300" }],
    },
    {
      registry,
      actor: STAFF,
      chainHooks,
      pendingStore,
      stepUpProofStore: proofStore,
    },
  );
  assert.equal(first.ok, false);
  const detail = !first.ok && "detail" in first.error ? first.error.detail : undefined;
  if (detail?.kind !== "confirmation") assert.fail("expected confirm_ref");

  const self = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "platform.settings.set",
    {},
    {
      registry,
      actor: STAFF,
      chainHooks,
      pendingStore,
      stepUpProofStore: proofStore,
      confirmRef: detail.confirm_ref,
    },
  );
  assert.equal(self.ok, false);
  if (!self.ok) assert.equal(self.error.code, "POLICY_DENIED");
});
