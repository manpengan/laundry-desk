import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  PIN_CHALLENGE_MAX_ATTEMPTS,
} from "@laundry/contracts";

import { createCsrfProofSigner } from "../auth/csrf.js";
import { createAccessTokenSigner } from "./crypto-util.js";
import { createLoginService } from "./login.js";
import { createMemoryIdentityStore } from "./memory-store.js";
import { createTestPasswordPort } from "./password.js";
import { createPinService, PIN_LOCKOUT_SECONDS } from "./pin.js";
import type { SessionRecord, StaffRecord } from "./types.js";
import { IdentityError } from "./types.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TARGET_STAFF_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DEVICE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const WRONG_PIN = "0000";
const CORRECT_PIN = "5678";

const mutableClock = (initial: number) => {
  let now = initial;
  return Object.freeze({
    nowEpochSeconds: () => now,
    advance: (seconds: number) => {
      now += seconds;
    },
  });
};

const expectIdentityCode = (code: IdentityError["code"]) => (error: unknown) => {
  assert.ok(error instanceof IdentityError);
  assert.equal(error.code, code);
  return true;
};

const createFixture = async () => {
  const store = createMemoryIdentityStore();
  const passwordPort = createTestPasswordPort();
  const passwordHash = await passwordPort.hashPassword("correct-horse");
  const targetPinHash = await passwordPort.hashPassword(CORRECT_PIN);
  const staff: StaffRecord = Object.freeze({
    staff_id: STAFF_ID,
    org_id: ORG_ID,
    username: "counter1",
    password_hash: passwordHash,
    pin_hash: await passwordPort.hashPassword("1234"),
    display_name: "Counter One",
    is_active: true,
    permission_version: 1,
  });
  const target: StaffRecord = Object.freeze({
    ...staff,
    staff_id: TARGET_STAFF_ID,
    username: "counter2",
    pin_hash: targetPinHash,
    display_name: "Counter Two",
  });
  store.seedOrgStore({
    org_id: ORG_ID,
    org_code: "local",
    store_id: STORE_ID,
    store_code: "main",
  });
  store.seedStaff(staff);
  store.seedStaff(target);

  const clock = mutableClock(1_700_000_000);
  const sessions = {
    sessions: store.sessions,
    refresh: store.refresh,
    lifecycle: store.lifecycle,
    clock,
    accessTokenSigner: createAccessTokenSigner({
      secret: "pin-cumulative-test-access-secret-32-byte",
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
    }),
    csrfProofMinter: createCsrfProofSigner("pin-cumulative-test-csrf-secret-32-byte"),
  };
  const login = createLoginService({
    staff: store.staff,
    orgStore: store.orgStore,
    passwordPort,
    sessions,
  });
  const issued = await login.login({
    org_code: "local",
    store_code: "main",
    username: "counter1",
    password: "correct-horse",
    device_id: DEVICE_ID,
  });
  const session = await store.sessions.get(issued.session.session_id);
  assert.ok(session);
  const pin = createPinService({
    challenges: store.pinChallenges,
    lockouts: store.pinLockouts,
    staff: store.staff,
    pinPort: passwordPort,
    clock,
    sessions,
  });
  return Object.freeze({ store, clock, pin, session });
};

type Fixture = Awaited<ReturnType<typeof createFixture>>;

const createChallenge = (fixture: Fixture, session: SessionRecord = fixture.session) =>
  fixture.pin.createQuickSwitchChallenge({
    purpose: "quick_switch",
    session,
    target_staff_id: TARGET_STAFF_ID,
  });

const failPin = async (
  fixture: Fixture,
  challengeId: string,
  expectedCode: IdentityError["code"] = "AUTHENTICATION_FAILED",
) => {
  await assert.rejects(
    () =>
      fixture.pin.verifyQuickSwitchPin({
        challenge_id: challengeId,
        pin: WRONG_PIN,
        session: fixture.session,
      }),
    expectIdentityCode(expectedCode),
  );
};

test("PIN failures accumulate across challenges and expire as one 15-minute window", async () => {
  const fixture = await createFixture();
  const challengeA = await createChallenge(fixture);
  for (let attempt = 0; attempt < PIN_CHALLENGE_MAX_ATTEMPTS - 1; attempt += 1) {
    await failPin(fixture, challengeA.challenge_id);
  }

  const challengeB = await createChallenge(fixture);
  await failPin(fixture, challengeB.challenge_id);
  const locked = await fixture.store.pinLockouts.get(ORG_ID, STORE_ID, TARGET_STAFF_ID, DEVICE_ID);
  assert.equal(locked?.failed_attempts, PIN_CHALLENGE_MAX_ATTEMPTS);
  assert.equal(locked?.locked_until, fixture.clock.nowEpochSeconds() + PIN_LOCKOUT_SECONDS);

  await assert.rejects(() => createChallenge(fixture), expectIdentityCode("PIN_LOCKED"));
  await assert.rejects(
    () =>
      fixture.pin.verifyQuickSwitchPin({
        challenge_id: challengeB.challenge_id,
        pin: CORRECT_PIN,
        session: fixture.session,
      }),
    expectIdentityCode("PIN_LOCKED"),
  );

  fixture.clock.advance(PIN_LOCKOUT_SECONDS);
  const afterExpiry = await createChallenge(fixture);
  await failPin(fixture, afterExpiry.challenge_id);
  const reset = await fixture.store.pinLockouts.get(ORG_ID, STORE_ID, TARGET_STAFF_ID, DEVICE_ID);
  assert.equal(reset?.failed_attempts, 1);
  assert.equal(reset?.locked_until, fixture.clock.nowEpochSeconds());
});

test("successful PIN clears cumulative failures below the threshold", async () => {
  const fixture = await createFixture();
  const failedChallenge = await createChallenge(fixture);
  await failPin(fixture, failedChallenge.challenge_id);
  await failPin(fixture, failedChallenge.challenge_id);
  assert.equal(
    (await fixture.store.pinLockouts.get(ORG_ID, STORE_ID, TARGET_STAFF_ID, DEVICE_ID))
      ?.failed_attempts,
    2,
  );

  const successfulChallenge = await createChallenge(fixture);
  const switched = await fixture.pin.verifyQuickSwitchPin({
    challenge_id: successfulChallenge.challenge_id,
    pin: CORRECT_PIN,
    session: fixture.session,
  });
  assert.equal(switched.session.staff_id, TARGET_STAFF_ID);
  assert.equal(
    await fixture.store.pinLockouts.get(ORG_ID, STORE_ID, TARGET_STAFF_ID, DEVICE_ID),
    null,
  );
});

test("concurrent fifth failures on different challenges create one consistent lockout", async () => {
  const fixture = await createFixture();
  const challengeA = await createChallenge(fixture);
  const challengeB = await createChallenge(fixture);
  const challengeC = await createChallenge(fixture);
  for (let attempt = 0; attempt < PIN_CHALLENGE_MAX_ATTEMPTS - 1; attempt += 1) {
    await failPin(fixture, challengeA.challenge_id);
  }

  const results = await Promise.allSettled([
    fixture.pin.verifyQuickSwitchPin({
      challenge_id: challengeB.challenge_id,
      pin: WRONG_PIN,
      session: fixture.session,
    }),
    fixture.pin.verifyQuickSwitchPin({
      challenge_id: challengeC.challenge_id,
      pin: WRONG_PIN,
      session: fixture.session,
    }),
  ]);
  const codes = results
    .map((result) => (result.status === "rejected" ? result.reason : null))
    .filter((error): error is IdentityError => error instanceof IdentityError)
    .map((error) => error.code)
    .sort();
  assert.deepEqual(codes, ["AUTHENTICATION_FAILED", "PIN_LOCKED"]);

  const lockout = await fixture.store.pinLockouts.get(ORG_ID, STORE_ID, TARGET_STAFF_ID, DEVICE_ID);
  assert.equal(lockout?.failed_attempts, PIN_CHALLENGE_MAX_ATTEMPTS);
  assert.equal(
    fixture.store
      .listChallenges()
      .reduce((total, challenge) => total + challenge.failed_attempts, 0),
    PIN_CHALLENGE_MAX_ATTEMPTS,
  );
});
