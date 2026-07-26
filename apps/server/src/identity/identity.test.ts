import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  ACCESS_TOKEN_TTL_SECONDS,
  PIN_CHALLENGE_MAX_ATTEMPTS,
  type AccessTokenClaims,
} from "@laundry/contracts";

import { buildAccessClaims, createAccessTokenSigner, mintCsrfProof } from "./crypto-util.js";
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
const ACCESS_TOKEN_SECRET = "test-access-secret-32-byte-minimum-value";

const encodeJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const signCompactToken = (
  secret: string,
  header: Readonly<Record<string, unknown>>,
  claims: AccessTokenClaims,
): string => {
  const protectedHeader = encodeJson(header);
  const payload = encodeJson(claims);
  const signature = createHmac("sha256", secret)
    .update(`${protectedHeader}.${payload}`, "utf8")
    .digest("base64url");
  return `${protectedHeader}.${payload}.${signature}`;
};

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

  return { store, login, sessions, pin, clock, passwordPort, signer, sessionDeps };
};

test("access-token claims include the fixed issuer, audience, and exact lifetime", () => {
  const claims = buildAccessClaims({
    session_id: "1131e8c3-b7e3-4633-8af8-a5e3286570e1",
    session_version: 1,
    org_id: ORG_ID,
    store_id: STORE_ID,
    staff_id: STAFF_ID,
    device_id: DEVICE_ID,
    permission_version: 1,
    authentication_method: "password",
    now: 1_700_000_000,
  });

  assert.equal(claims.iss, ACCESS_TOKEN_ISSUER);
  assert.equal(claims.aud, ACCESS_TOKEN_AUDIENCE);
  assert.equal(claims.exp - claims.iat, ACCESS_TOKEN_TTL_SECONDS);
});

test("access-token signer rejects every non-exact protected header", () => {
  const signer = createAccessTokenSigner({
    secret: ACCESS_TOKEN_SECRET,
    issuer: ACCESS_TOKEN_ISSUER,
    audience: ACCESS_TOKEN_AUDIENCE,
  });
  const claims = buildAccessClaims({
    session_id: "1131e8c3-b7e3-4633-8af8-a5e3286570e1",
    session_version: 1,
    org_id: ORG_ID,
    store_id: STORE_ID,
    staff_id: STAFF_ID,
    device_id: DEVICE_ID,
    permission_version: 1,
    authentication_method: "password",
    now: 1_700_000_000,
  });
  const invalidHeaders = [
    {},
    { alg: "HS256" },
    { typ: "AT" },
    { alg: "none", typ: "AT" },
    { alg: "HS256", typ: "JWT" },
    { alg: "HS256", typ: "AT", kid: "unexpected" },
  ] as const;

  for (const header of invalidHeaders) {
    assert.equal(
      signer.verify(signCompactToken(ACCESS_TOKEN_SECRET, header, claims)),
      null,
      JSON.stringify(header),
    );
  }
});

test("access-token signer rejects invalid configuration", () => {
  assert.throws(() =>
    createAccessTokenSigner({
      secret: "too-short",
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
    }),
  );
  assert.throws(() =>
    createAccessTokenSigner({
      secret: ACCESS_TOKEN_SECRET,
      issuer: "wrong-issuer" as typeof ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
    }),
  );
  assert.throws(() =>
    createAccessTokenSigner({
      secret: ACCESS_TOKEN_SECRET,
      issuer: ACCESS_TOKEN_ISSUER,
      audience: "wrong-audience" as typeof ACCESS_TOKEN_AUDIENCE,
    }),
  );
});

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
  const { clock, login, sessions, signer, store } = await seedStore();
  const first = await login.login({
    org_code: "hongfa",
    store_code: "main",
    username: "counter1",
    password: "correct-horse",
    device_id: DEVICE_ID,
  });

  clock.advance(1);
  const rotated = await sessions.rotateRefresh(first.refresh.refresh_token);
  assert.notEqual(rotated.refresh.refresh_token, first.refresh.refresh_token);
  assert.notEqual(rotated.access_token, first.access_token);
  assert.equal(rotated.session.session_id, first.session.session_id);
  const rotatedClaims = signer.verify(rotated.access_token);
  assert.ok(rotatedClaims);
  assert.equal(rotatedClaims.authentication_method, "password");

  // Reuse of the already-rotated refresh token → family revoked.
  await assert.rejects(() => sessions.rotateRefresh(first.refresh.refresh_token), IdentityError);

  const family = store.listFamilies().find((row) => row.session_id === first.session.session_id);
  assert.ok(family);
  assert.equal(family.status, "revoked");

  const session = store.listSessions().find((row) => row.session_id === first.session.session_id);
  assert.ok(session);
  assert.equal(session.status, "revoked");
});

test("concurrent reuse of one active refresh secret revokes its session family", async () => {
  const { login, sessions, store } = await seedStore();
  const issued = await login.login({
    org_code: "hongfa",
    store_code: "main",
    username: "counter1",
    password: "correct-horse",
    device_id: DEVICE_ID,
  });

  const attempts = await Promise.allSettled([
    sessions.rotateRefresh(issued.refresh.refresh_token),
    sessions.rotateRefresh(issued.refresh.refresh_token),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);

  const family = store.listFamilies().find((row) => row.session_id === issued.session.session_id);
  const session = store.listSessions().find((row) => row.session_id === issued.session.session_id);
  assert.equal(family?.status, "revoked");
  assert.equal(session?.status, "revoked");
});

test("rotated refresh reuse revokes the family even after staff authority is disabled", async () => {
  const { login, sessions, store } = await seedStore();
  const issued = await login.login({
    org_code: "hongfa",
    store_code: "main",
    username: "counter1",
    password: "correct-horse",
    device_id: DEVICE_ID,
  });
  await sessions.rotateRefresh(issued.refresh.refresh_token);
  const staff = await store.staff.findById(ORG_ID, STAFF_ID);
  assert.ok(staff);
  store.seedStaff(Object.freeze({ ...staff, is_active: false }));

  await assert.rejects(() => sessions.rotateRefresh(issued.refresh.refresh_token), IdentityError);
  const family = store.listFamilies().find((row) => row.session_id === issued.session.session_id);
  const session = store.listSessions().find((row) => row.session_id === issued.session.session_id);
  assert.equal(family?.status, "revoked");
  assert.equal(session?.status, "revoked");
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
    org_id: session.org_id,
    store_id: session.store_id,
    staff_id: session.staff_id,
    device_id: session.device_id,
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

test("concurrent final PIN failures create one lockout without double-consuming", async () => {
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

  for (let attempt = 1; attempt < PIN_CHALLENGE_MAX_ATTEMPTS; attempt += 1) {
    await assert.rejects(() =>
      pin.verifyQuickSwitchPin({
        challenge_id: challenge.challenge_id,
        pin: "0000",
        session,
      }),
    );
  }
  const finalAttempts = await Promise.allSettled([
    pin.verifyQuickSwitchPin({
      challenge_id: challenge.challenge_id,
      pin: "0000",
      session,
    }),
    pin.verifyQuickSwitchPin({
      challenge_id: challenge.challenge_id,
      pin: "0000",
      session,
    }),
  ]);

  assert.equal(
    finalAttempts.every((attempt) => attempt.status === "rejected"),
    true,
  );
  const codes = finalAttempts
    .map((attempt) => (attempt.status === "rejected" ? attempt.reason : null))
    .filter((error): error is IdentityError => error instanceof IdentityError)
    .map((error) => error.code)
    .sort();
  assert.deepEqual(codes, ["AUTHENTICATION_FAILED", "PIN_CHALLENGE_INVALID"]);
  const lockout = await store.pinLockouts.get(ORG_ID, STORE_ID, STAFF_B_ID, DEVICE_ID);
  assert.equal(lockout?.failed_attempts, PIN_CHALLENGE_MAX_ATTEMPTS);
  assert.equal(store.listChallenges()[0]?.failed_attempts, PIN_CHALLENGE_MAX_ATTEMPTS);
});

test("a lockout committed after PIN precheck still blocks a concurrent correct switch", async () => {
  const { login, store, clock, passwordPort, sessionDeps } = await seedStore();
  const issued = await login.login({
    org_code: "hongfa",
    store_code: "main",
    username: "counter1",
    password: "correct-horse",
    device_id: DEVICE_ID,
  });
  const session = await store.sessions.get(issued.session.session_id);
  assert.ok(session);
  const wrongChallenge = await createPinService({
    challenges: store.pinChallenges,
    lockouts: store.pinLockouts,
    staff: store.staff,
    pinPort: passwordPort,
    clock,
    sessions: sessionDeps,
  }).createQuickSwitchChallenge({
    purpose: "quick_switch",
    session,
    target_staff_id: STAFF_B_ID,
  });
  for (let failed = 0; failed < PIN_CHALLENGE_MAX_ATTEMPTS - 1; failed += 1) {
    assert.equal(
      await store.pinChallenges.recordFailure({
        challenge_id: wrongChallenge.challenge_id,
        org_id: ORG_ID,
        store_id: STORE_ID,
        staff_id: STAFF_B_ID,
        device_id: DEVICE_ID,
        expected_failed_attempts: failed,
        next_failed_attempts: failed + 1,
        attempted_at: clock.nowEpochSeconds(),
        locked_until: clock.nowEpochSeconds() + PIN_LOCKOUT_SECONDS,
      }),
      1,
    );
  }
  const correctChallenge = await createPinService({
    challenges: store.pinChallenges,
    lockouts: store.pinLockouts,
    staff: store.staff,
    pinPort: passwordPort,
    clock,
    sessions: sessionDeps,
  }).createQuickSwitchChallenge({
    purpose: "quick_switch",
    session,
    target_staff_id: STAFF_B_ID,
  });

  let releaseWrong: ((valid: boolean) => void) | undefined;
  let releaseCorrect: ((valid: boolean) => void) | undefined;
  const controlledPin = createPinService({
    challenges: store.pinChallenges,
    lockouts: store.pinLockouts,
    staff: store.staff,
    pinPort: Object.freeze({
      ...passwordPort,
      verifyPassword: (candidate: string) =>
        new Promise<boolean>((resolve) => {
          if (candidate === "0000") releaseWrong = resolve;
          else releaseCorrect = resolve;
        }),
    }),
    clock,
    sessions: sessionDeps,
  });
  const wrong = controlledPin.verifyQuickSwitchPin({
    challenge_id: wrongChallenge.challenge_id,
    pin: "0000",
    session,
  });
  const correct = controlledPin.verifyQuickSwitchPin({
    challenge_id: correctChallenge.challenge_id,
    pin: "5678",
    session,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(releaseWrong);
  assert.ok(releaseCorrect);
  releaseWrong(false);
  await assert.rejects(wrong, IdentityError);
  releaseCorrect(true);
  await assert.rejects(correct, IdentityError);

  assert.equal(store.listSessions().filter((row) => row.status === "active").length, 1);
  assert.equal(
    (await store.pinLockouts.get(ORG_ID, STORE_ID, STAFF_B_ID, DEVICE_ID))?.failed_attempts,
    PIN_CHALLENGE_MAX_ATTEMPTS,
  );
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

test("a stale quick-switch challenge cannot revive a replaced session", async () => {
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
  const firstChallenge = await pin.createQuickSwitchChallenge({
    purpose: "quick_switch",
    session,
    target_staff_id: STAFF_B_ID,
  });
  const staleChallenge = await pin.createQuickSwitchChallenge({
    purpose: "quick_switch",
    session,
    target_staff_id: STAFF_B_ID,
  });

  await pin.verifyQuickSwitchPin({
    challenge_id: firstChallenge.challenge_id,
    pin: "5678",
    session,
  });
  await assert.rejects(
    () =>
      pin.verifyQuickSwitchPin({
        challenge_id: staleChallenge.challenge_id,
        pin: "5678",
        session,
      }),
    IdentityError,
  );
  assert.equal(store.listSessions().filter((row) => row.status === "active").length, 1);
  assert.equal(store.listFamilies().filter((row) => row.status === "active").length, 1);
});

test("logout wins over a later quick-switch verification", async () => {
  const { login, pin, sessions, store } = await seedStore();
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
  await sessions.logoutSession({
    org_id: session.org_id,
    store_id: session.store_id,
    staff_id: session.staff_id,
    device_id: session.device_id,
    session_id: session.session_id,
    family_id: session.family_id,
    session_version: session.session_version,
  });

  await assert.rejects(
    () =>
      pin.verifyQuickSwitchPin({
        challenge_id: challenge.challenge_id,
        pin: "5678",
        session,
      }),
    IdentityError,
  );
  assert.equal(store.listSessions().filter((row) => row.status === "active").length, 0);
  assert.equal(store.listFamilies().filter((row) => row.status === "active").length, 0);
});

test("quick switch rejects authority drift before consuming the challenge", async () => {
  const { login, pin, store } = await seedStore();
  const issued = await login.login({
    org_code: "hongfa",
    store_code: "main",
    username: "counter1",
    password: "correct-horse",
    device_id: DEVICE_ID,
  });
  const session = await store.sessions.get(issued.session.session_id);
  const target = await store.staff.findById(ORG_ID, STAFF_B_ID);
  assert.ok(session);
  assert.ok(target);
  const challenge = await pin.createQuickSwitchChallenge({
    purpose: "quick_switch",
    session,
    target_staff_id: STAFF_B_ID,
  });
  store.seedStaff(
    Object.freeze({
      ...target,
      permission_version: target.permission_version + 1,
    }),
  );

  await assert.rejects(
    () =>
      pin.verifyQuickSwitchPin({
        challenge_id: challenge.challenge_id,
        pin: "5678",
        session,
        expected_target_permission_version: target.permission_version,
      }),
    (error: unknown) => {
      assert.ok(error instanceof IdentityError);
      assert.equal(error.code, "SESSION_INVALID");
      return true;
    },
  );
  assert.equal(store.listChallenges()[0]?.status, "active");
  assert.equal((await store.sessions.get(session.session_id))?.status, "active");
});

test("mintCsrfProof matches contracts format", () => {
  const proof = mintCsrfProof();
  assert.match(proof, /^v1\.[A-Za-z0-9_-]{43,128}$/u);
});
