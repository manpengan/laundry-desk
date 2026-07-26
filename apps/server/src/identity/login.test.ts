import assert from "node:assert/strict";
import test from "node:test";

import { createArgon2idPasswordPort, type PasswordPort } from "./password.js";
import {
  preparePasswordLogin,
  type PasswordLoginDeps,
  type PreparedPasswordLogin,
} from "./login.js";
import { IdentityError, type StaffRecord } from "./types.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEVICE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REAL_HASH = "test$real";
const DUMMY_HASH = "test$dummy";

const ACTIVE_STAFF: StaffRecord = Object.freeze({
  staff_id: STAFF_ID,
  org_id: ORG_ID,
  username: "counter",
  password_hash: REAL_HASH,
  pin_hash: null,
  display_name: "Counter",
  is_active: true,
  permission_version: 3,
});

type VerifyCall = Readonly<{ password: string; storedHash: string }>;

function createDeps(options: {
  orgStoreFound?: boolean;
  staff?: StaffRecord | null;
  validPassword?: string;
}): Readonly<{ deps: PasswordLoginDeps; calls: VerifyCall[] }> {
  const calls: VerifyCall[] = [];
  const validPassword = options.validPassword ?? "correct";
  const passwordPort: PasswordPort = Object.freeze({
    hashPassword: async () => {
      throw new Error("not used");
    },
    verifyPassword: async (password, storedHash) => {
      calls.push(Object.freeze({ password, storedHash }));
      return storedHash === REAL_HASH && password === validPassword;
    },
  });
  return Object.freeze({
    deps: Object.freeze({
      orgStore: Object.freeze({
        findByCodes: async () =>
          options.orgStoreFound === false
            ? null
            : Object.freeze({
                org_id: ORG_ID,
                org_code: "local",
                store_id: STORE_ID,
                store_code: "main",
              }),
      }),
      staff: Object.freeze({
        findByOrgUsername: async () => options.staff ?? null,
        findById: async () => null,
      }),
      passwordPort,
      dummyPasswordHash: DUMMY_HASH,
    }),
    calls,
  });
}

const request = Object.freeze({
  org_code: "local",
  store_code: "main",
  username: "counter",
  password: "correct",
  device_id: DEVICE_ID,
});

async function authenticationFailure(
  deps: PasswordLoginDeps,
  rawRequest: unknown = request,
): Promise<void> {
  await assert.rejects(
    () => preparePasswordLogin(deps, rawRequest),
    (error: unknown) => error instanceof IdentityError && error.code === "AUTHENTICATION_FAILED",
  );
}

test("an active account performs exactly one real-hash verification and can succeed", async () => {
  const { deps, calls } = createDeps({ staff: ACTIVE_STAFF });
  const prepared: PreparedPasswordLogin = await preparePasswordLogin(deps, request);

  assert.deepEqual(calls, [{ password: "correct", storedHash: REAL_HASH }]);
  assert.equal(prepared.staff_id, STAFF_ID);
  assert.equal(prepared.permission_version, 3);
});

test("an active account with a wrong password performs exactly one real-hash verification", async () => {
  const { deps, calls } = createDeps({
    staff: ACTIVE_STAFF,
    validPassword: "different",
  });
  await authenticationFailure(deps);
  assert.deepEqual(calls, [{ password: "correct", storedHash: REAL_HASH }]);
});

test("unknown org/store performs exactly one dummy-hash verification", async () => {
  const { deps, calls } = createDeps({ orgStoreFound: false });
  await authenticationFailure(deps);
  assert.deepEqual(calls, [{ password: "correct", storedHash: DUMMY_HASH }]);
});

test("the production fallback performs one verification through a valid Argon2id hash", async () => {
  const argon2id = createArgon2idPasswordPort();
  let verificationCompleted = false;
  let callCount = 0;
  const deps: PasswordLoginDeps = Object.freeze({
    orgStore: Object.freeze({ findByCodes: async () => null }),
    staff: Object.freeze({
      findByOrgUsername: async () => null,
      findById: async () => null,
    }),
    passwordPort: Object.freeze({
      hashPassword: argon2id.hashPassword,
      verifyPassword: async (password: string, storedHash: string) => {
        callCount += 1;
        assert.match(storedHash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
        const matches = await argon2id.verifyPassword(password, storedHash);
        verificationCompleted = true;
        return matches;
      },
    }),
  });

  await authenticationFailure(deps);
  assert.equal(callCount, 1);
  assert.equal(verificationCompleted, true);
});

test("unknown user performs exactly one dummy-hash verification", async () => {
  const { deps, calls } = createDeps({ staff: null });
  await authenticationFailure(deps);
  assert.deepEqual(calls, [{ password: "correct", storedHash: DUMMY_HASH }]);
});

test("inactive staff performs exactly one dummy-hash verification and cannot succeed", async () => {
  const { deps, calls } = createDeps({
    staff: Object.freeze({ ...ACTIVE_STAFF, is_active: false }),
  });
  await authenticationFailure(deps);
  assert.deepEqual(calls, [{ password: "correct", storedHash: DUMMY_HASH }]);
});

test("malformed requests still perform exactly one bounded dummy-hash verification", async () => {
  const malformedRequests: readonly unknown[] = [
    null,
    {},
    { ...request, password: "" },
    { ...request, password: "x".repeat(1_025) },
    { ...request, device_id: "not-a-uuid" },
    Object.freeze({
      ...request,
      get password(): string {
        throw new Error("untrusted getter");
      },
    }),
  ];

  for (const malformed of malformedRequests) {
    const { deps, calls } = createDeps({ staff: ACTIVE_STAFF });
    await authenticationFailure(deps, malformed);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.storedHash, DUMMY_HASH);
    assert.ok((calls[0]?.password.length ?? 0) >= 1);
    assert.ok((calls[0]?.password.length ?? Number.MAX_SAFE_INTEGER) <= 1_024);
  }
});

test("password verifier failures propagate instead of becoming credential failures", async () => {
  const sentinel = new Error("argon2 runtime unavailable");
  const { deps } = createDeps({ staff: ACTIVE_STAFF });
  const failingDeps: PasswordLoginDeps = Object.freeze({
    ...deps,
    passwordPort: Object.freeze({
      ...deps.passwordPort,
      verifyPassword: async () => {
        throw sentinel;
      },
    }),
  });

  await assert.rejects(
    () => preparePasswordLogin(failingDeps, request),
    (error) => error === sentinel,
  );
});
