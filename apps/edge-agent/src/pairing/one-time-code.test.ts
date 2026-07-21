import assert from "node:assert/strict";
import test from "node:test";

import {
  PAIRING_CODE_DIGITS,
  PAIRING_CODE_TTL_MS,
  generateDigitCode,
  OneTimePairingCodeService,
} from "./one-time-code.js";

test("generateDigitCode produces zero-padded digits of fixed length", () => {
  for (let i = 0; i < 20; i += 1) {
    const code = generateDigitCode(PAIRING_CODE_DIGITS);
    assert.equal(code.length, PAIRING_CODE_DIGITS);
    assert.match(code, /^\d{6}$/u);
  }
});

test("create returns a 60s window and status is active", () => {
  const service = new OneTimePairingCodeService();
  const now = 1_000_000;
  const issued = service.create(now);
  assert.equal(issued.expiresAtMs, now + PAIRING_CODE_TTL_MS);
  assert.equal(service.status(now).active, true);
  assert.equal(service.status(now).expiresAtMs, issued.expiresAtMs);
});

test("consume succeeds once then rejects double-consume", () => {
  const service = new OneTimePairingCodeService();
  const now = 2_000_000;
  const { code } = service.create(now);
  assert.deepEqual(service.consume(code, now + 1), { ok: true });
  const second = service.consume(code, now + 2);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error, "already_consumed");
});

test("consume rejects expired code", () => {
  const service = new OneTimePairingCodeService();
  const now = 3_000_000;
  const { code, expiresAtMs } = service.create(now);
  const expired = service.consume(code, expiresAtMs);
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.error, "expired");
  assert.equal(service.status(expiresAtMs).active, false);
});

test("consume rejects mismatch and missing", () => {
  const service = new OneTimePairingCodeService();
  assert.deepEqual(service.consume("000000"), { ok: false, error: "not_found" });
  const now = 4_000_000;
  service.create(now);
  const bad = service.consume("999999", now);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error, "mismatch");
});

test("creating a new code invalidates the previous unconsumed code", () => {
  const service = new OneTimePairingCodeService();
  const now = 5_000_000;
  const first = service.create(now);
  const second = service.create(now + 10);
  const stale = service.consume(first.code, now + 20);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error, "mismatch");
  assert.deepEqual(service.consume(second.code, now + 20), { ok: true });
});
