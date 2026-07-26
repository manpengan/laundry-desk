import assert from "node:assert/strict";
import test from "node:test";

import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER, CsrfProofSchema } from "@laundry/contracts";

import {
  CSRF_HEADER_NAME,
  assertCsrf,
  assertNoTenantAuthorityHeaders,
  checkCsrfDoubleSubmit,
  createSessionResolver,
  AuthError,
} from "./index.js";
import { createCsrfProofSigner } from "./csrf.js";
import { createAccessTokenSigner } from "../identity/crypto-util.js";
import { createLoginService } from "../identity/login.js";
import { createMemoryIdentityStore } from "../identity/memory-store.js";
import { createTestPasswordPort } from "../identity/password.js";
import type { StaffRecord } from "../identity/types.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEVICE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ACCESS_TOKEN_SECRET = "auth-test-secret-32-byte-minimum-value";
const CSRF_PROOF_SECRET = "auth-test-csrf-proof-secret-minimum";
const OTHER_CSRF_PROOF_SECRET = "auth-test-other-csrf-secret-minimum";
const CSRF_BINDING = Object.freeze({
  session_id: "11111111-1111-4111-8111-111111111111",
  session_version: 1,
  rotation_nonce: "33333333-3333-4333-8333-333333333333",
});
const ROTATED_CSRF_BINDING = Object.freeze({
  ...CSRF_BINDING,
  rotation_nonce: "44444444-4444-4444-8444-444444444444",
});

const setup = async () => {
  const store = createMemoryIdentityStore();
  const passwordPort = createTestPasswordPort();
  const passwordHash = await passwordPort.hashPassword("secret");
  store.seedOrgStore({
    org_id: ORG_ID,
    org_code: "hongfa",
    store_id: STORE_ID,
    store_code: "main",
  });
  const staff: StaffRecord = Object.freeze({
    staff_id: STAFF_ID,
    org_id: ORG_ID,
    username: "alice",
    password_hash: passwordHash,
    pin_hash: null,
    display_name: "Alice",
    is_active: true,
    permission_version: 1,
  });
  store.seedStaff(staff);

  const clock = { nowEpochSeconds: () => 1_700_000_000 };
  const signer = createAccessTokenSigner({
    secret: ACCESS_TOKEN_SECRET,
    issuer: ACCESS_TOKEN_ISSUER,
    audience: ACCESS_TOKEN_AUDIENCE,
  });
  const sessionDeps = {
    sessions: store.sessions,
    refresh: store.refresh,
    lifecycle: store.lifecycle,
    clock,
    accessTokenSigner: signer,
    csrfProofMinter: createCsrfProofSigner(CSRF_PROOF_SECRET),
  };
  const login = createLoginService({
    staff: store.staff,
    orgStore: store.orgStore,
    passwordPort,
    sessions: sessionDeps,
  });
  const resolver = createSessionResolver({
    sessions: store.sessions,
    accessTokenSigner: signer,
    clock,
  });
  return { login, resolver, store, signer, clock };
};

test("resolveSessionFromBearer builds AuthContext from server session only", async () => {
  const { login, resolver } = await setup();
  const issued = await login.login({
    org_code: "hongfa",
    store_code: "main",
    username: "alice",
    password: "secret",
    device_id: DEVICE_ID,
  });

  const ctx = await resolver.resolve({
    authorizationHeader: `Bearer ${issued.access_token}`,
    via: "ui",
  });

  assert.equal(ctx.actor.staff_id, STAFF_ID);
  assert.equal(ctx.tenant.org_id, ORG_ID);
  assert.equal(ctx.tenant.store_id, STORE_ID);
  assert.equal(ctx.session_id, issued.session.session_id);
  assert.equal(ctx.actor.via, "ui");
});

test("spoof org/store headers are rejected (not used as authority)", async () => {
  const { login, resolver } = await setup();
  const issued = await login.login({
    org_code: "hongfa",
    store_code: "main",
    username: "alice",
    password: "secret",
    device_id: DEVICE_ID,
  });

  await assert.rejects(
    () =>
      resolver.resolve({
        authorizationHeader: `Bearer ${issued.access_token}`,
        headers: {
          "x-org-id": "ffffffff-ffff-4fff-8fff-ffffffffffff",
          "x-store-id": "99999999-9999-4999-8999-999999999999",
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.code, "TENANT_SPOOF_REJECTED");
      return true;
    },
  );

  assert.throws(
    () =>
      assertNoTenantAuthorityHeaders({
        "X-Staff-Id": STAFF_ID,
      }),
    AuthError,
  );
});

test("missing bearer is rejected", async () => {
  const { resolver } = await setup();
  await assert.rejects(
    () => resolver.resolve({ authorizationHeader: null }),
    (err: unknown) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.code, "AUTHENTICATION_FAILED");
      return true;
    },
  );
});

test("revoked session rejects even if token not expired", async () => {
  const { login, resolver, store } = await setup();
  const issued = await login.login({
    org_code: "hongfa",
    store_code: "main",
    username: "alice",
    password: "secret",
    device_id: DEVICE_ID,
  });
  await store.sessions.revoke(issued.session.session_id, 2, 1_700_000_001);

  await assert.rejects(
    () =>
      resolver.resolve({
        authorizationHeader: `Bearer ${issued.access_token}`,
      }),
    AuthError,
  );
});

test("authentication method in access claims must match the server session", async () => {
  const { login, resolver, signer } = await setup();
  const issued = await login.login({
    org_code: "hongfa",
    store_code: "main",
    username: "alice",
    password: "secret",
    device_id: DEVICE_ID,
  });
  const claims = signer.verify(issued.access_token);
  assert.ok(claims);

  const mismatchedToken = signer.sign({
    ...claims,
    authentication_method: "pin",
  });

  await assert.rejects(
    () =>
      resolver.resolve({
        authorizationHeader: `Bearer ${mismatchedToken}`,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.code, "AUTHENTICATION_FAILED");
      return true;
    },
  );
});

test("tenant authority headers are rejected by presence, including empty values", () => {
  assert.throws(
    () =>
      assertNoTenantAuthorityHeaders({
        "x-org-id": "",
      }),
    (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.code, "TENANT_SPOOF_REJECTED");
      return true;
    },
  );
});

test("CSRF signer mints a contract-valid proof for the complete server binding", () => {
  const signer = createCsrfProofSigner(CSRF_PROOF_SECRET);

  const first = signer.mint(CSRF_BINDING);
  const second = signer.mint(CSRF_BINDING);

  assert.equal(CsrfProofSchema.safeParse(first).success, true);
  assert.match(first, /^v1\.[A-Za-z0-9_-]{43,128}$/u);
  assert.equal(first, second);
  assert.equal(signer.verify(first, CSRF_BINDING), true);
  assert.equal(signer.verify(second, CSRF_BINDING), true);
});

test("CSRF signer rejects another session, version, rotation nonce, secret, or tampered proof", () => {
  const signer = createCsrfProofSigner(CSRF_PROOF_SECRET);
  const proof = signer.mint(CSRF_BINDING);
  const replacement = proof.endsWith("A") ? "B" : "A";
  const tampered = `${proof.slice(0, -1)}${replacement}`;

  assert.equal(
    signer.verify(proof, {
      ...CSRF_BINDING,
      session_id: "22222222-2222-4222-8222-222222222222",
    }),
    false,
  );
  assert.equal(
    signer.verify(proof, {
      ...CSRF_BINDING,
      session_version: CSRF_BINDING.session_version + 1,
    }),
    false,
  );
  assert.equal(
    signer.verify(proof, {
      ...ROTATED_CSRF_BINDING,
    }),
    false,
  );
  assert.equal(createCsrfProofSigner(OTHER_CSRF_PROOF_SECRET).verify(proof, CSRF_BINDING), false);
  assert.equal(signer.verify(tampered, CSRF_BINDING), false);
});

test("CSRF proof rotation changes the proof and invalidates the previous nonce binding", () => {
  const signer = createCsrfProofSigner(CSRF_PROOF_SECRET);
  const previousProof = signer.mint(CSRF_BINDING);
  const rotatedProof = signer.mint(ROTATED_CSRF_BINDING);

  assert.notEqual(previousProof, rotatedProof);
  assert.equal(signer.verify(previousProof, ROTATED_CSRF_BINDING), false);
  assert.equal(signer.verify(rotatedProof, ROTATED_CSRF_BINDING), true);
});

test("CSRF signer rejects malformed proofs and invalid bindings", () => {
  const signer = createCsrfProofSigner(CSRF_PROOF_SECRET);
  const malformed = [
    "",
    "v1.",
    `v1.${"A".repeat(43)}`,
    `v1.${"A".repeat(95)}`,
    `v1.${"A".repeat(97)}`,
    `v1.${"A".repeat(96)}=`,
    `v2.${"A".repeat(96)}`,
  ];

  for (const proof of malformed) {
    assert.equal(signer.verify(proof, CSRF_BINDING), false);
  }

  assert.equal(
    signer.verify(`v1.${"A".repeat(96)}`, {
      ...CSRF_BINDING,
      session_id: "not-a-session-id",
    }),
    false,
  );
  assert.equal(
    signer.verify(`v1.${"A".repeat(96)}`, {
      ...CSRF_BINDING,
      session_version: 0,
    }),
    false,
  );
  assert.throws(
    () =>
      signer.mint({
        ...CSRF_BINDING,
        session_version: Number.MAX_SAFE_INTEGER + 1,
      }),
    /session_version/u,
  );
  assert.throws(
    () =>
      signer.mint({
        ...CSRF_BINDING,
        session_id: "not-a-session-id",
      }),
    /session_id/u,
  );
  assert.throws(
    () =>
      signer.mint({
        ...CSRF_BINDING,
        rotation_nonce: "not-a-rotation-nonce",
      }),
    /rotation_nonce/u,
  );
});

test("CSRF signer rejects secrets shorter than 32 UTF-8 bytes", () => {
  assert.throws(() => createCsrfProofSigner("too-short"), /at least 32 UTF-8 bytes/u);
});

test("CSRF mismatch rejected on unsafe methods", () => {
  const signer = createCsrfProofSigner(CSRF_PROOF_SECRET);
  const token = signer.mint(CSRF_BINDING);
  const differentToken = signer.mint(ROTATED_CSRF_BINDING);
  const mismatch = checkCsrfDoubleSubmit({
    method: "POST",
    surface: { kind: "browser", fetch_site: "same-origin" },
    cookie_token: token,
    header_token: differentToken,
    proof_signer: signer,
    proof_binding: CSRF_BINDING,
  });
  assert.equal(mismatch.allowed, false);
  if (!mismatch.allowed) {
    assert.equal(mismatch.reason, "TOKEN_MISMATCH");
  }

  assert.throws(
    () =>
      assertCsrf({
        method: "POST",
        surface: { kind: "browser", fetch_site: "same-origin" },
        cookie_token: token,
        header_token: differentToken,
        proof_signer: signer,
        proof_binding: CSRF_BINDING,
      }),
    (err: unknown) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.code, "CSRF_REJECTED");
      return true;
    },
  );
});

test("CSRF missing tokens rejected on unsafe methods", () => {
  const signer = createCsrfProofSigner(CSRF_PROOF_SECRET);
  const result = checkCsrfDoubleSubmit({
    method: "POST",
    surface: { kind: "browser", fetch_site: "same-origin" },
    cookie_token: null,
    header_token: null,
    proof_signer: signer,
    proof_binding: CSRF_BINDING,
  });
  assert.equal(result.allowed, false);
  if (!result.allowed) {
    assert.equal(result.reason, "TOKEN_MISSING");
  }
});

test("CSRF matching double-submit allows POST", () => {
  const signer = createCsrfProofSigner(CSRF_PROOF_SECRET);
  const token = signer.mint(CSRF_BINDING);
  const result = checkCsrfDoubleSubmit({
    method: "POST",
    surface: { kind: "browser", fetch_site: "same-origin" },
    cookie_token: token,
    header_token: token,
    proof_signer: signer,
    proof_binding: CSRF_BINDING,
  });
  assert.equal(result.allowed, true);
});

test("CSRF matching transport values require both valid syntax and a verified proof", () => {
  const signer = createCsrfProofSigner(CSRF_PROOF_SECRET);
  const arbitraryContractProof = `v1.${"A".repeat(96)}`;
  const invalidMac = checkCsrfDoubleSubmit({
    method: "POST",
    surface: { kind: "browser", fetch_site: "same-site" },
    cookie_token: arbitraryContractProof,
    header_token: arbitraryContractProof,
    proof_signer: signer,
    proof_binding: CSRF_BINDING,
  });
  assert.deepEqual(invalidMac, { allowed: false, reason: "PROOF_INVALID" });

  const malformed = `v1.${"A".repeat(42)}`;
  const invalidSyntax = checkCsrfDoubleSubmit({
    method: "POST",
    surface: { kind: "browser", fetch_site: "same-site" },
    cookie_token: malformed,
    header_token: malformed,
    proof_signer: signer,
    proof_binding: CSRF_BINDING,
  });
  assert.deepEqual(invalidSyntax, { allowed: false, reason: "PROOF_INVALID" });
});

test("CSRF not required for safe GET", () => {
  const result = checkCsrfDoubleSubmit({
    method: "GET",
    surface: { kind: "untrusted" },
    cookie_token: null,
    header_token: null,
  });
  assert.equal(result.allowed, true);
});

test("CSRF permits same-origin only for a request-security-verified desktop surface", () => {
  const signer = createCsrfProofSigner(CSRF_PROOF_SECRET);
  const token = signer.mint(CSRF_BINDING);
  const trustedDesktop = checkCsrfDoubleSubmit({
    method: "POST",
    surface: { kind: "trusted-desktop", fetch_site: "same-origin" },
    cookie_token: token,
    header_token: token,
    proof_signer: signer,
    proof_binding: CSRF_BINDING,
  });
  const browserNone = checkCsrfDoubleSubmit({
    method: "POST",
    surface: { kind: "browser", fetch_site: "none" },
    cookie_token: token,
    header_token: token,
    proof_signer: signer,
    proof_binding: CSRF_BINDING,
  });

  assert.deepEqual(trustedDesktop, { allowed: true });
  assert.deepEqual(browserNone, { allowed: false, reason: "FETCH_METADATA_REJECTED" });
});

test("CSRF header name aligns with contracts", () => {
  assert.equal(CSRF_HEADER_NAME, "x-csrf-token");
});
