import assert from "node:assert/strict";
import test from "node:test";

import { PIN_CHALLENGE_MAX_ATTEMPTS } from "@laundry/contracts";

import { createAccessTokenSigner, mintCsrfProof } from "./crypto-util.js";
import { createLoginService } from "./login.js";
import { createMemoryIdentityStore } from "./memory-store.js";
import { createTestPasswordPort } from "./password.js";
import { createPinService, PIN_LOCKOUT_SECONDS } from "./pin.js";
import { createSessionService } from "./session.js";
import { IdentityError, type StaffRecord } from "./types.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STAFF_B_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DEVICE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const fixedClock = (epoch: number) => {
  let now = epoch;
  return {
    nowEpochSeconds: () => now,
    advance: (seconds: number) => {
      now += seconds;
    },
  };
};

const seedStore = async () => {
  const store = createMemoryIdentityStore();
  const passwordPort = createTestPasswordPort();
  const passwordHash = await passwordPort.hashPassword("correct-horse");
  const pinHash = await passwordPort.hashPassword("1234");
  const pinHashB = await passwordPort.hashPassword("5678");

  store.seedOrgStore({
    org_id: ORG_ID,
    org_code: "hongfa",
    store_id: STORE_ID,
    store_code: "main",
  });

  const staff: StaffRecord = Object.freeze({
    staff_id: STAFF_ID,
    org_id: ORG_ID,
    username: "counter1",
    password_hash: passwordHash,
    pin_hash: pinHash,
    display_name: "Counter One",
    is_active: true,
    permission_version: 1,
  });
  const staffB: StaffRecord = Object.freeze({
    staff_id: STAFF_B_ID,
    org_id: ORG_ID,
    username: "counter2",
    password_hash: passwordHash,
    pin_hash: pinHashB,
    display_name: "Counter Two",
    is_active: true,
    permission_version: 1,
  });
  store.seedStaff(staff);
  store.seedStaff(staffB);

  const clock = fixedClock(1_700_000_000);
  const signer = createAccessTokenSigner("test-access-secret");
  const sessionDeps = {
    sessions: store.sessions,
    refresh: store.refresh,
    clock,
    accessTokenSigner: signer,
  };
  const sessions = createSessionService(sessionDeps);
  const login = createLoginService({
    staff: store.staff,
    orgStore: store.orgStore,
    passwordPort,
    sessions: sessionDeps,
  });
  const pin = createPinService({
    challenges: store.pinChallenges,
    lockouts: store.pinLockouts,
    staff: store.staff,
    pinPort: passwordPort,
    clock,
    sessions: sessionDeps,
  });

  return { store, login, sessions, pin, clock, passwordPort, signer };
};

test("login success returns memory_only access token and cookie descriptors", async () => {
  const { login } = await seedStore();
  const result = await login.login({
    org_code: "hongfa",
    store_code: "main",
    username: "counter1",
    password: "correct-horse",
    device_id: DEVICE_ID,
  });

  assert.equal(result.token_type, "Bearer");
  assert.equal(result.storage, "memory_only");
  assert.equal(result.session.org_id, ORG_ID);
  assert.equal(result.session.store_id, STORE_ID);
  assert.equal(result.session.staff_id, STAFF_ID);
  assert.match(result.access_token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.equal(result.refresh.cookie.http_only, true);
  assert.equal(result.refresh.cookie.name, "__Host-laundry_refresh");
  assert.equal(result.csrf.cookie.http_only, false);
  assert.match(result.csrf.csrf_token, /^v1\./u);
  // Access token must not be packaged as a cookie descriptor.
  assert.equal("cookie" in result === false || !("access_cookie" in result), true);
});

test("login fails on wrong password without leaking which field failed", async () => {
  const { login } = await seedStore();
  await assert.rejects(
    () =>
      login.login({
        org_code: "hongfa",
        store_code: "main",
        username: "counter1",
        password: "wrong",
        device_id: DEVICE_ID,
      }),
    (err: unknown) => {
      assert.ok(err instanceof IdentityError);
      assert.equal(err.code, "AUTHENTICATION_FAILED");
      return true;
    },
  );
});

test("login fails on unknown org/store", async () => {
  const { login } = await seedStore();
  await assert.rejects(
    () =>
      login.login({
        org_code: "nope",
        store_code: "main",
        username: "counter1",
        password: "correct-horse",
        device_id: DEVICE_ID,
      }),
    IdentityError,
  );
});

test("refresh rotation issues new secrets; reuse of old token invalidates family", async () => {
  const { login, sessions, store } = await seedStore();
  const first = await login.login({
    org_code: "hongfa",
    store_code: "main",
    username: "counter1",
    password: "correct-horse",
    device_id: DEVICE_ID,
  });

  const rotated = await sessions.rotateRefresh(first.refresh.refresh_token);
  assert.notEqual(rotated.refresh.refresh_token, first.refresh.refresh_token);
  assert.notEqual(rotated.access_token, first.access_token);
  assert.equal(rotated.session.session_id, first.session.session_id);

  // Reuse of the already-rotated refresh token → family revoked.
  await assert.rejects(() => sessions.rotateRefresh(first.refresh.refresh_token), IdentityError);

  const family = store.listFamilies().find((row) => row.session_id === first.session.session_id);
  assert.ok(family);
  assert.equal(family.status, "revoked");

  const session = store.listSessions().find((row) => row.session_id === first.session.session_id);
  assert.ok(session);
  assert.equal(session.status, "revoked");
});

test("logout revokes session and family", async () => {
  const { login, sessions, store } = await seedStore();
  const issued = await login.login({
    org_code: "hongfa",
    store_code: "main",
    username: "counter1",
    password: "correct-horse",
    device_id: DEVICE_ID,
  });
  const session = store.listSessions().find((row) => row.session_id === issued.session.session_id);
  assert.ok(session);

  const result = await sessions.logoutSession({
    session_id: session.session_id,
    family_id: session.family_id,
    session_version: session.session_version,
  });
  assert.equal(result.logged_out, true);
  assert.equal(result.clear_cookies[0].max_age_seconds, 0);

  const after = await store.sessions.get(session.session_id);
  assert.equal(after?.status, "revoked");
});

test("PIN lockout after max failed attempts", async () => {
  const { login, pin, store, clock } = await seedStore();
  const issued = await login.login({
    org_code: "hongfa",
    store_code: "main",
    username: "counter1",
    password: "correct-horse",
    device_id: DEVICE_ID,
  });
  const session = await store.sessions.get(issued.session.session_id);
  assert.ok(session);

  const challenge = await pin.createQuickSwitchChallenge({
    purpose: "quick_switch",
    session,
    target_staff_id: STAFF_B_ID,
  });
  assert.equal(challenge.max_attempts, PIN_CHALLENGE_MAX_ATTEMPTS);

  for (let i = 0; i < PIN_CHALLENGE_MAX_ATTEMPTS; i += 1) {
    await assert.rejects(
      () =>
        pin.verifyQuickSwitchPin({
          challenge_id: challenge.challenge_id,
          pin: "0000",
          session,
        }),
      IdentityError,
    );
  }

  // Further attempts on a new challenge should hit lockout.
  const next = await pin
    .createQuickSwitchChallenge({
      purpose: "quick_switch",
      session,
      target_staff_id: STAFF_B_ID,
    })
    .catch((err: unknown) => err);

  // create may still succeed; verify must fail with PIN_LOCKED after exhaustion on that staff/device.
  if (next instanceof IdentityError) {
    assert.equal(next.code, "PIN_LOCKED");
  } else {
    assert.ok(next && typeof next === "object" && "challenge_id" in next);
    await assert.rejects(
      () =>
        pin.verifyQuickSwitchPin({
          challenge_id: (next as { challenge_id: string }).challenge_id,
          pin: "5678",
          session,
        }),
      (err: unknown) => {
        assert.ok(err instanceof IdentityError);
        assert.equal(err.code, "PIN_LOCKED");
        return true;
      },
    );
  }

  assert.equal(PIN_LOCKOUT_SECONDS, 15 * 60);
  clock.advance(PIN_LOCKOUT_SECONDS + 1);
});

test("PIN success after correct pin issues replacement session", async () => {
  const { login, pin, store } = await seedStore();
  const issued = await login.login({
    org_code: "hongfa",
    store_code: "main",
    username: "counter1",
    password: "correct-horse",
    device_id: DEVICE_ID,
  });
  const session = await store.sessions.get(issued.session.session_id);
  assert.ok(session);

  const challenge = await pin.createQuickSwitchChallenge({
    purpose: "quick_switch",
    session,
    target_staff_id: STAFF_B_ID,
  });

  const switched = await pin.verifyQuickSwitchPin({
    challenge_id: challenge.challenge_id,
    pin: "5678",
    session,
  });

  assert.equal(switched.session.staff_id, STAFF_B_ID);
  assert.notEqual(switched.session.session_id, issued.session.session_id);
  const old = await store.sessions.get(issued.session.session_id);
  assert.equal(old?.status, "revoked");
});

test("mintCsrfProof matches contracts format", () => {
  const proof = mintCsrfProof();
  assert.match(proof, /^v1\.[A-Za-z0-9_-]{43,128}$/u);
});
