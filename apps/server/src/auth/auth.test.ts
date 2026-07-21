import assert from "node:assert/strict";
import test from "node:test";

import {
  CSRF_HEADER_NAME,
  assertCsrf,
  assertNoTenantAuthorityHeaders,
  checkCsrfDoubleSubmit,
  createSessionResolver,
  AuthError,
} from "./index.js";
import { createAccessTokenSigner, mintCsrfProof } from "../identity/crypto-util.js";
import { createLoginService } from "../identity/login.js";
import { createMemoryIdentityStore } from "../identity/memory-store.js";
import { createTestPasswordPort } from "../identity/password.js";
import type { StaffRecord } from "../identity/types.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEVICE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

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
  const signer = createAccessTokenSigner("auth-test-secret");
  const sessionDeps = {
    sessions: store.sessions,
    refresh: store.refresh,
    clock,
    accessTokenSigner: signer,
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

test("CSRF mismatch rejected on unsafe methods", () => {
  const token = mintCsrfProof();
  const mismatch = checkCsrfDoubleSubmit({
    method: "POST",
    origin_allowed: true,
    fetch_site: "same-origin",
    cookie_token: token,
    header_token: mintCsrfProof(),
  });
  assert.equal(mismatch.allowed, false);
  if (!mismatch.allowed) {
    assert.equal(mismatch.reason, "TOKEN_MISMATCH");
  }

  assert.throws(
    () =>
      assertCsrf({
        method: "POST",
        origin_allowed: true,
        fetch_site: "same-origin",
        cookie_token: token,
        header_token: mintCsrfProof(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.code, "CSRF_REJECTED");
      return true;
    },
  );
});

test("CSRF missing tokens rejected on unsafe methods", () => {
  const result = checkCsrfDoubleSubmit({
    method: "POST",
    origin_allowed: true,
    fetch_site: "same-origin",
    cookie_token: null,
    header_token: null,
  });
  assert.equal(result.allowed, false);
  if (!result.allowed) {
    assert.equal(result.reason, "TOKEN_MISSING");
  }
});

test("CSRF matching double-submit allows POST", () => {
  const token = mintCsrfProof();
  const result = checkCsrfDoubleSubmit({
    method: "POST",
    origin_allowed: true,
    fetch_site: "same-origin",
    cookie_token: token,
    header_token: token,
  });
  assert.equal(result.allowed, true);
});

test("CSRF not required for safe GET", () => {
  const result = checkCsrfDoubleSubmit({
    method: "GET",
    origin_allowed: false,
    fetch_site: "cross-site",
    cookie_token: null,
    header_token: null,
  });
  assert.equal(result.allowed, true);
});

test("CSRF header name aligns with contracts", () => {
  assert.equal(CSRF_HEADER_NAME, "x-csrf-token");
});
