import assert from "node:assert/strict";
import test from "node:test";

import {
  LoginRateLimitInputError,
  LoginRateLimitReservationError,
  createLoginRateLimiter,
  type LoginRateLimitAttempt,
  type LoginRateLimitClock,
  type LoginRateLimitInput,
  type LoginRateLimitPolicy,
  type LoginRateLimitReservation,
} from "./login-rate-limit.js";

const START_MS = 1_700_000_000_000;
const WINDOW_MS = 60_000;
const BLOCK_MS = 120_000;
const ATTEMPT_LEASE_MS = 30_000;

const ACCOUNT_A: LoginRateLimitInput = Object.freeze({
  org_code: "local",
  store_code: "main",
  username: "admin",
  ip: "192.0.2.10",
});

const ACCOUNT_B: LoginRateLimitInput = Object.freeze({
  org_code: "local",
  store_code: "main",
  username: "staff",
  ip: "192.0.2.11",
});

function createMutableClock(startMs = START_MS): Readonly<{
  clock: LoginRateLimitClock;
  advance: (milliseconds: number) => void;
  rewind: (milliseconds: number) => void;
}> {
  let nowMs = startMs;
  return Object.freeze({
    clock: Object.freeze({ nowMs: () => nowMs }),
    advance: (milliseconds: number): void => {
      nowMs += milliseconds;
    },
    rewind: (milliseconds: number): void => {
      nowMs -= milliseconds;
    },
  });
}

function policy(maxFailures: number): LoginRateLimitPolicy {
  return Object.freeze({
    maxFailures,
    windowMs: WINDOW_MS,
    blockMs: BLOCK_MS,
  });
}

function withInput(
  input: LoginRateLimitInput,
  changes: Partial<LoginRateLimitInput>,
): LoginRateLimitInput {
  return Object.freeze({ ...input, ...changes });
}

function requireReservation(attempt: LoginRateLimitAttempt): LoginRateLimitReservation {
  assert.equal(attempt.allowed, true);
  if (!attempt.allowed) assert.fail("expected a reserved login attempt");
  return attempt.reservation;
}

function failAttempt(
  limiter: ReturnType<typeof createLoginRateLimiter>,
  input: LoginRateLimitInput,
) {
  return requireReservation(limiter.beginAttempt(input)).fail();
}

test("account failures share a normalized org/store/username key across IPs", () => {
  const time = createMutableClock();
  const limiter = createLoginRateLimiter({
    clock: time.clock,
    account: policy(2),
    ip: policy(20),
    attemptLeaseMs: ATTEMPT_LEASE_MS,
  });

  assert.deepEqual(
    failAttempt(
      limiter,
      withInput(ACCOUNT_A, {
        org_code: "LOCAL",
        store_code: "Main",
        username: "AdMiN",
      }),
    ),
    { allowed: true },
  );

  assert.deepEqual(
    failAttempt(
      limiter,
      withInput(ACCOUNT_A, {
        org_code: "local",
        store_code: "MAIN",
        username: "ADMIN",
        ip: "192.0.2.99",
      }),
    ),
    { allowed: false, retryAfterSeconds: 120 },
  );
  assert.deepEqual(limiter.beginAttempt(ACCOUNT_A), {
    allowed: false,
    retryAfterSeconds: 120,
  });
});

test("IP failures share one normalized IPv6 key across accounts", () => {
  const time = createMutableClock();
  const limiter = createLoginRateLimiter({
    clock: time.clock,
    account: policy(20),
    ip: policy(2),
    attemptLeaseMs: ATTEMPT_LEASE_MS,
  });

  assert.deepEqual(
    failAttempt(
      limiter,
      withInput(ACCOUNT_A, {
        ip: "0:0:0:0:0:0:0:1",
      }),
    ),
    { allowed: true },
  );

  assert.deepEqual(
    failAttempt(
      limiter,
      withInput(ACCOUNT_B, {
        ip: "::1",
      }),
    ),
    { allowed: false, retryAfterSeconds: 120 },
  );

  assert.deepEqual(
    limiter.beginAttempt(
      withInput(ACCOUNT_A, {
        username: "owner",
        ip: "::1",
      }),
    ),
    { allowed: false, retryAfterSeconds: 120 },
  );
});

test("IPv4-mapped IPv6 and IPv4 share one IP bucket", () => {
  const time = createMutableClock();
  const limiter = createLoginRateLimiter({
    clock: time.clock,
    account: policy(20),
    ip: policy(2),
    attemptLeaseMs: ATTEMPT_LEASE_MS,
  });

  assert.deepEqual(
    failAttempt(
      limiter,
      withInput(ACCOUNT_A, {
        ip: "::ffff:192.0.2.10",
      }),
    ),
    { allowed: true },
  );
  assert.deepEqual(
    failAttempt(
      limiter,
      withInput(ACCOUNT_B, {
        ip: "192.0.2.10",
      }),
    ),
    { allowed: false, retryAfterSeconds: 120 },
  );
});

test("a successful reservation clears account failures without clearing IP failures", () => {
  const time = createMutableClock();
  const limiter = createLoginRateLimiter({
    clock: time.clock,
    account: policy(2),
    ip: policy(2),
    attemptLeaseMs: ATTEMPT_LEASE_MS,
  });

  assert.deepEqual(failAttempt(limiter, ACCOUNT_A), { allowed: true });
  requireReservation(
    limiter.beginAttempt(
      withInput(ACCOUNT_A, {
        org_code: "LOCAL",
        store_code: "MAIN",
        username: "ADMIN",
        ip: "192.0.2.12",
      }),
    ),
  ).succeed();

  assert.deepEqual(
    failAttempt(
      limiter,
      withInput(ACCOUNT_A, {
        ip: "192.0.2.12",
      }),
    ),
    { allowed: true },
    "the normalized account bucket must have been cleared",
  );

  assert.deepEqual(
    failAttempt(
      limiter,
      withInput(ACCOUNT_B, {
        ip: ACCOUNT_A.ip,
      }),
    ),
    { allowed: false, retryAfterSeconds: 120 },
    "success must not erase the source IP failure",
  );
});

test("failure windows and blocks expire against the injected clock", () => {
  const time = createMutableClock();
  const limiter = createLoginRateLimiter({
    clock: time.clock,
    account: policy(2),
    ip: policy(20),
    attemptLeaseMs: ATTEMPT_LEASE_MS,
  });

  assert.deepEqual(failAttempt(limiter, ACCOUNT_A), { allowed: true });
  time.advance(WINDOW_MS);
  requireReservation(limiter.beginAttempt(ACCOUNT_A)).release();

  assert.deepEqual(failAttempt(limiter, ACCOUNT_A), { allowed: true });
  assert.deepEqual(failAttempt(limiter, ACCOUNT_A), {
    allowed: false,
    retryAfterSeconds: 120,
  });

  time.advance(BLOCK_MS - 1);
  assert.deepEqual(limiter.beginAttempt(ACCOUNT_A), {
    allowed: false,
    retryAfterSeconds: 1,
  });
  time.advance(1);
  requireReservation(limiter.beginAttempt(ACCOUNT_A)).release();
});

test("bounded maps fail closed for unseen keys and recover after expiry", () => {
  const time = createMutableClock();
  const limiter = createLoginRateLimiter({
    clock: time.clock,
    account: policy(20),
    ip: policy(20),
    maxAccountEntries: 2,
    maxIpEntries: 2,
    attemptLeaseMs: ATTEMPT_LEASE_MS,
  });

  assert.deepEqual(failAttempt(limiter, ACCOUNT_A), { allowed: true });
  assert.deepEqual(failAttempt(limiter, ACCOUNT_B), { allowed: true });

  const unseen = Object.freeze({
    org_code: "another",
    store_code: "branch",
    username: "owner",
    ip: "192.0.2.12",
  });
  assert.deepEqual(limiter.beginAttempt(unseen), {
    allowed: false,
    retryAfterSeconds: 60,
  });

  time.advance(WINDOW_MS);
  assert.deepEqual(failAttempt(limiter, unseen), { allowed: true });
});

test("blocked decisions are frozen, minimal, and never echo account or IP input", () => {
  const time = createMutableClock();
  const limiter = createLoginRateLimiter({
    clock: time.clock,
    account: policy(1),
    ip: policy(20),
    attemptLeaseMs: ATTEMPT_LEASE_MS,
  });

  const decision = failAttempt(limiter, ACCOUNT_A);
  assert.deepEqual(decision, { allowed: false, retryAfterSeconds: 120 });
  assert.equal(Object.isFrozen(decision), true);
  assert.deepEqual(Object.keys(decision), ["allowed", "retryAfterSeconds"]);

  const serialized = JSON.stringify(decision);
  assert.doesNotMatch(serialized, /local|main|admin|192\.0\.2\.10/u);
});

test("beginAttempt reserves account and IP capacity synchronously at threshold one", () => {
  const limiter = createLoginRateLimiter({
    account: policy(1),
    ip: policy(1),
    attemptLeaseMs: ATTEMPT_LEASE_MS,
  });

  const first = requireReservation(limiter.beginAttempt(ACCOUNT_A));
  assert.deepEqual(
    limiter.beginAttempt(withInput(ACCOUNT_A, { ip: "192.0.2.99" })),
    { allowed: false, retryAfterSeconds: 30 },
    "same account cannot start a second password verification",
  );
  assert.deepEqual(
    limiter.beginAttempt(withInput(ACCOUNT_B, { ip: ACCOUNT_A.ip })),
    { allowed: false, retryAfterSeconds: 30 },
    "same IP cannot start a second password verification",
  );
  first.release();
});

test("threshold two permits exactly two concurrent reservations and release restores capacity", () => {
  const limiter = createLoginRateLimiter({
    account: policy(2),
    ip: policy(20),
    attemptLeaseMs: ATTEMPT_LEASE_MS,
  });

  const first = requireReservation(limiter.beginAttempt(ACCOUNT_A));
  const second = requireReservation(
    limiter.beginAttempt(withInput(ACCOUNT_A, { ip: "192.0.2.12" })),
  );
  assert.deepEqual(limiter.beginAttempt(withInput(ACCOUNT_A, { ip: "192.0.2.13" })), {
    allowed: false,
    retryAfterSeconds: 30,
  });

  first.release();
  const replacement = requireReservation(
    limiter.beginAttempt(withInput(ACCOUNT_A, { ip: "192.0.2.13" })),
  );
  second.release();
  replacement.release();
});

test("active reservations count toward bounded-map capacity and release the opaque slot", () => {
  const limiter = createLoginRateLimiter({
    account: policy(20),
    ip: policy(20),
    maxAccountEntries: 1,
    maxIpEntries: 1,
    attemptLeaseMs: ATTEMPT_LEASE_MS,
  });

  const occupied = requireReservation(limiter.beginAttempt(ACCOUNT_A));
  assert.deepEqual(limiter.beginAttempt(ACCOUNT_B), {
    allowed: false,
    retryAfterSeconds: 30,
  });

  occupied.release();
  requireReservation(limiter.beginAttempt(ACCOUNT_B)).release();
});

test("reservations can be finalized exactly once", () => {
  const limiter = createLoginRateLimiter({
    account: policy(2),
    ip: policy(20),
    attemptLeaseMs: ATTEMPT_LEASE_MS,
  });

  const succeeded = requireReservation(limiter.beginAttempt(ACCOUNT_A));
  succeeded.succeed();
  assert.throws(() => succeeded.succeed(), LoginRateLimitReservationError);
  assert.throws(() => succeeded.fail(), LoginRateLimitReservationError);
  assert.throws(() => succeeded.release(), LoginRateLimitReservationError);

  const failed = requireReservation(limiter.beginAttempt(ACCOUNT_A));
  failed.fail();
  assert.throws(() => failed.release(), LoginRateLimitReservationError);

  const released = requireReservation(limiter.beginAttempt(ACCOUNT_B));
  released.release();
  assert.throws(() => released.fail(), LoginRateLimitReservationError);
});

test("expired leaked reservations recover capacity and reject late finalization", () => {
  const time = createMutableClock();
  const limiter = createLoginRateLimiter({
    clock: time.clock,
    account: policy(1),
    ip: policy(1),
    attemptLeaseMs: ATTEMPT_LEASE_MS,
  });

  const leaked = requireReservation(limiter.beginAttempt(ACCOUNT_A));
  time.advance(ATTEMPT_LEASE_MS);
  const recovered = requireReservation(limiter.beginAttempt(ACCOUNT_A));
  assert.throws(() => leaked.release(), LoginRateLimitReservationError);
  recovered.release();
});

test("all operations strictly reject malformed or credential-bearing inputs", () => {
  const limiter = createLoginRateLimiter();
  const invalidInputs: readonly unknown[] = [
    null,
    {},
    { ...ACCOUNT_A, password: "must-not-enter-limiter" },
    { ...ACCOUNT_A, pin: "1234" },
    { ...ACCOUNT_A, access_token: "secret-token" },
    { ...ACCOUNT_A, org_code: "" },
    { ...ACCOUNT_A, store_code: " main" },
    { ...ACCOUNT_A, username: "admin\nowner" },
    { ...ACCOUNT_A, username: "a".repeat(129) },
    { ...ACCOUNT_A, ip: "not-an-ip" },
    { ...ACCOUNT_A, ip: "127.0.0.1:8787" },
  ];

  for (const input of invalidInputs) {
    assert.throws(
      () => limiter.beginAttempt(input),
      (error: unknown) => {
        if (!(error instanceof LoginRateLimitInputError)) return false;
        assert.equal(error.message, "Invalid login rate-limit input");
        assert.doesNotMatch(
          String(error),
          /must-not-enter-limiter|1234|secret-token|admin\nowner|not-an-ip/u,
        );
        return true;
      },
    );
  }
});

test("configuration and clock failures are rejected without input details", () => {
  assert.throws(
    () => createLoginRateLimiter({ maxAccountEntries: 0 }),
    /Invalid login rate-limit configuration/u,
  );
  assert.throws(
    () =>
      createLoginRateLimiter({
        account: { maxFailures: 1, windowMs: 0, blockMs: BLOCK_MS },
      }),
    /Invalid login rate-limit configuration/u,
  );
  assert.throws(
    () => createLoginRateLimiter({ attemptLeaseMs: 0 }),
    /Invalid login rate-limit configuration/u,
  );

  const time = createMutableClock();
  const limiter = createLoginRateLimiter({ clock: time.clock });
  requireReservation(limiter.beginAttempt(ACCOUNT_A)).release();
  time.rewind(1);
  assert.throws(() => limiter.beginAttempt(ACCOUNT_A), /Invalid login rate-limit clock/u);
});
