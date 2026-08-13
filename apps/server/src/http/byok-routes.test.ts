import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";

import { CSRF_HEADER_NAME } from "@laundry/contracts";

import type { ByokKmsPort } from "../ai/byok-kms.js";
import { MemoryByokStore } from "../ai/byok-memory-store.js";
import { TestByokKms } from "../ai/byok-test-kms.js";
import type { ByokStoreContext } from "../ai/byok-types.js";
import { createStepUpProof } from "../policy/step-up.js";
import { MemoryStepUpProofStore } from "../policy/step-up-proof-store.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import { DEFAULT_STORE_FEATURES } from "../platform/features.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const DEVICE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const APPROVER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PROOF_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const REVOKE_PROOF_ID = "77777777-7777-4777-8777-777777777777";
const STAFF_DEVICE_ID = "99999999-9999-4999-8999-999999999999";
const HOST = Object.freeze({ host: "127.0.0.1:8787" });
const MUTATION = Object.freeze({
  ...HOST,
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});
const cookies = resolveCookiePolicy({ secure: false });

class OrderedByokStore extends MemoryByokStore {
  constructor(private readonly events: string[]) {
    super();
  }

  override async snapshotProvider(providerCode: string, context: ByokStoreContext) {
    this.events.push("provider");
    return super.snapshotProvider(providerCode, context);
  }
}

class OrderedPendingStore extends MemoryPendingActionStore {
  constructor(private readonly events: string[]) {
    super();
  }

  override lockPrivacy(): void {
    this.events.push("pending");
  }
}

type BrowserSession = Readonly<{
  token: string;
  cookie: string;
  csrf: string;
  sessionId: string;
  sessionVersion: number;
}>;

function cookieValues(headers: Record<string, unknown>): Record<string, string> {
  const raw = headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return Object.fromEntries(
    values.flatMap((line) => {
      const pair = line.split(";", 1)[0];
      if (pair === undefined) return [];
      const separator = pair.indexOf("=");
      return separator > 0 ? [[pair.slice(0, separator), pair.slice(separator + 1)]] : [];
    }),
  );
}

async function login(
  app: FastifyInstance,
  runtime: LocalRuntime,
  username = "admin",
  deviceId = DEVICE_ID,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: MUTATION,
    payload: {
      org_code: "local",
      store_code: "main",
      username,
      password: DEMO_PASSWORD,
      device_id: deviceId,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as Readonly<{ data: Readonly<{ access_token: string }> }>;
  const values = cookieValues(response.headers as Record<string, unknown>);
  const claims = runtime.identity.sessions.accessTokenSigner.verify(body.data.access_token);
  assert.ok(claims);
  return Object.freeze({
    token: body.data.access_token,
    cookie: Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
    csrf: values[LOCAL_COOKIE_NAMES.csrf] ?? "",
    sessionId: claims.session_id,
    sessionVersion: claims.session_version,
  }) satisfies BrowserSession;
}

function authHeaders(session: BrowserSession, csrf = true): Record<string, string> {
  return {
    ...MUTATION,
    authorization: `Bearer ${session.token}`,
    cookie: session.cookie,
    ...(csrf ? { [CSRF_HEADER_NAME]: session.csrf } : {}),
  };
}

async function buildApp(
  kms: ByokKmsPort | null = new TestByokKms(),
  stores: Readonly<{
    pending?: MemoryPendingActionStore;
    byok?: MemoryByokStore;
  }> = {},
) {
  const base = await createMemoryLocalRuntime();
  const pendingStore = stores.pending ?? new MemoryPendingActionStore();
  const stepUpProofStore = new MemoryStepUpProofStore();
  const runtime: LocalRuntime = Object.freeze({
    ...base,
    identity: Object.freeze({
      ...base.identity,
      ...(base.identity.pinStepUp === undefined
        ? {}
        : {
            pinStepUp: Object.freeze({
              ...base.identity.pinStepUp,
              pending: pendingStore,
              proofs: stepUpProofStore,
            }),
          }),
    }),
    pendingStore,
    stepUpProofStore,
    stepUpApproverAuthority: async () => true,
  });
  const byokStore = stores.byok ?? new MemoryByokStore();
  const app = await createLocalApp({
    runtime,
    cookiePolicy: cookies,
    logger: false,
    ...(kms === null ? {} : { byokKms: kms }),
    byokStore,
  });
  return { app, runtime, byokStore };
}

async function createReplaceIntent(app: FastifyInstance, session: BrowserSession) {
  return app.inject({
    method: "POST",
    url: "/api/v2/ai/provider-credential-intents",
    headers: authHeaders(session),
    payload: {
      operation: "replace",
      provider_code: "vendor-a",
      idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
  });
}

test("dedicated ingress enforces admin, CSRF, R5 proof, redacted response, and one-time use", async () => {
  const { app, runtime, byokStore } = await buildApp();
  const admin = await login(app, runtime);
  const staff = await login(app, runtime, "staff", STAFF_DEVICE_ID);

  const staffList = await app.inject({
    method: "GET",
    url: "/api/v2/ai/provider-credentials",
    headers: { ...HOST, authorization: `Bearer ${staff.token}` },
  });
  assert.equal(staffList.statusCode, 403);
  const models = await app.inject({
    method: "GET",
    url: "/api/v2/ai/models",
    headers: { ...HOST, authorization: `Bearer ${admin.token}` },
  });
  assert.equal(models.statusCode, 200, models.body);
  assert.deepEqual(models.json(), { ok: true, data: { items: [] } });

  const noCsrf = await app.inject({
    method: "POST",
    url: "/api/v2/ai/provider-credential-intents",
    headers: authHeaders(admin, false),
    payload: {
      operation: "replace",
      provider_code: "vendor-a",
      idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
  });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal((noCsrf.json() as { error: { code: string } }).error.code, "CSRF_REJECTED");

  const intent = await createReplaceIntent(app, admin);
  assert.equal(intent.statusCode, 200, intent.body);
  const confirmRef = (intent.json() as { data: { confirm_ref: string } }).data.confirm_ref;
  const claims = runtime.identity.sessions.accessTokenSigner.verify(admin.token);
  assert.ok(claims);
  const scoped = Object.freeze({
    orgId: claims.org_id,
    storeId: claims.store_id,
    staffId: claims.staff_id,
  });
  const pending = await runtime.pendingStore.get(confirmRef, { tenant: scoped });
  assert.ok(pending);
  assert.doesNotMatch(JSON.stringify(pending.args), /sk-live|secret-value/u);
  await runtime.stepUpProofStore.insert(
    createStepUpProof({
      proofId: PROOF_ID,
      pending,
      approverStaffId: APPROVER_ID,
      issuedAt: runtime.identity.sessions.clock.nowEpochSeconds(),
      sessionBinding: { sessionId: admin.sessionId, sessionVersion: admin.sessionVersion },
    }),
    { tenant: scoped },
  );
  const secret = "sk-live-secret-value-ABCD";
  const stored = await app.inject({
    method: "POST",
    url: "/api/v2/ai/provider-credentials/secret",
    headers: authHeaders(admin),
    payload: { confirm_ref: confirmRef, step_up_proof_id: PROOF_ID, api_key: secret },
  });
  assert.equal(stored.statusCode, 200, stored.body);
  assert.doesNotMatch(stored.body, new RegExp(secret, "u"));
  assert.doesNotMatch(stored.body, /ciphertext|wrapped_dek|kms_key/iu);
  assert.equal((stored.json() as { data: { last4: string } }).data.last4, "ABCD");
  const rows = await byokStore.listCredentials({ tenant: scoped });
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]?.envelope.ciphertext.toString("ascii"), secret);
  const credentialRef = rows[0]?.id;
  assert.ok(credentialRef);
  const listed = await app.inject({
    method: "GET",
    url: "/api/v2/ai/provider-credentials",
    headers: { ...HOST, authorization: `Bearer ${admin.token}` },
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.doesNotMatch(listed.body, new RegExp(secret, "u"));
  assert.doesNotMatch(listed.body, /ciphertext|wrapped_dek|kms_key/iu);

  const replay = await app.inject({
    method: "POST",
    url: "/api/v2/ai/provider-credentials/secret",
    headers: authHeaders(admin),
    payload: { confirm_ref: confirmRef, step_up_proof_id: PROOF_ID, api_key: secret },
  });
  assert.equal(replay.statusCode, 403, replay.body);

  const revokeIntent = await app.inject({
    method: "POST",
    url: "/api/v2/ai/provider-credential-intents",
    headers: authHeaders(admin),
    payload: {
      operation: "revoke",
      provider_code: "vendor-a",
      credential_ref: credentialRef,
      idempotency_key: "66666666-6666-4666-8666-666666666666",
    },
  });
  assert.equal(revokeIntent.statusCode, 200, revokeIntent.body);
  const revokeRef = (revokeIntent.json() as { data: { confirm_ref: string } }).data.confirm_ref;
  const revokePending = await runtime.pendingStore.get(revokeRef, { tenant: scoped });
  assert.ok(revokePending);
  await runtime.stepUpProofStore.insert(
    createStepUpProof({
      proofId: REVOKE_PROOF_ID,
      pending: revokePending,
      approverStaffId: APPROVER_ID,
      issuedAt: runtime.identity.sessions.clock.nowEpochSeconds(),
      sessionBinding: { sessionId: admin.sessionId, sessionVersion: admin.sessionVersion },
    }),
    { tenant: scoped },
  );
  const revoked = await app.inject({
    method: "POST",
    url: `/api/v2/ai/provider-credentials/${credentialRef}/revoke`,
    headers: authHeaders(admin),
    payload: { confirm_ref: revokeRef, step_up_proof_id: REVOKE_PROOF_ID },
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal((revoked.json() as { data: { status: string } }).data.status, "revoked");
  await app.close();
});

test("replace intent fails closed when no KMS adapter is injected", async () => {
  assert.equal(DEFAULT_STORE_FEATURES.ai, false);
  const { app, runtime } = await buildApp(null);
  const admin = await login(app, runtime);
  const response = await createReplaceIntent(app, admin);
  assert.equal(response.statusCode, 409, response.body);
  assert.equal((response.json() as { error: { code: string } }).error.code, "RESOURCE_UNAVAILABLE");
  await app.close();
});

test("intent takes provider authority before pending authority", async () => {
  const events: string[] = [];
  const { app, runtime } = await buildApp(new TestByokKms(), {
    pending: new OrderedPendingStore(events),
    byok: new OrderedByokStore(events),
  });
  const admin = await login(app, runtime);
  const response = await createReplaceIntent(app, admin);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(events, ["provider", "pending"]);
  await app.close();
});

test("secret ingress revalidates the creator after KMS work and before persistence", async () => {
  const innerKms = new TestByokKms();
  let revokeCreator = async (): Promise<void> => undefined;
  const kms: ByokKmsPort = Object.freeze({
    async wrapDataKey(input) {
      await revokeCreator();
      return innerKms.wrapDataKey(input);
    },
    unwrapDataKey: (input) => innerKms.unwrapDataKey(input),
  });
  const { app, runtime, byokStore } = await buildApp(kms);
  const admin = await login(app, runtime);
  const intent = await createReplaceIntent(app, admin);
  assert.equal(intent.statusCode, 200, intent.body);
  const confirmRef = (intent.json() as { data: { confirm_ref: string } }).data.confirm_ref;
  const claims = runtime.identity.sessions.accessTokenSigner.verify(admin.token);
  assert.ok(claims);
  const tenant = Object.freeze({
    orgId: claims.org_id,
    storeId: claims.store_id,
    staffId: claims.staff_id,
  });
  const pending = await runtime.pendingStore.get(confirmRef, { tenant });
  assert.ok(pending);
  const proofId = "55555555-5555-4555-8555-555555555555";
  await runtime.stepUpProofStore.insert(
    createStepUpProof({
      proofId,
      pending,
      approverStaffId: APPROVER_ID,
      issuedAt: runtime.identity.sessions.clock.nowEpochSeconds(),
      sessionBinding: { sessionId: admin.sessionId, sessionVersion: admin.sessionVersion },
    }),
    { tenant },
  );
  revokeCreator = async () => {
    const current = await runtime.identity.sessions.sessions.get(admin.sessionId);
    assert.ok(current);
    assert.equal(
      await runtime.identity.sessions.sessions.revoke(
        current.session_id,
        current.session_version + 1,
        runtime.identity.sessions.clock.nowEpochSeconds(),
      ),
      true,
    );
  };

  const response = await app.inject({
    method: "POST",
    url: "/api/v2/ai/provider-credentials/secret",
    headers: authHeaders(admin),
    payload: { confirm_ref: confirmRef, step_up_proof_id: proofId, api_key: "sk-race-safe-ABCD" },
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal((response.json() as { error: { code: string } }).error.code, "POLICY_DENIED");
  assert.deepEqual(await byokStore.listCredentialMetadata({ tenant }), []);
  assert.equal((await runtime.pendingStore.get(confirmRef, { tenant }))?.status, "pending");
  await app.close();
});
