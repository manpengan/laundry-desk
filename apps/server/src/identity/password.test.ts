/**
 * Password port tests: Argon2id default + scrypt legacy verify.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ARGON2ID_DEFAULTS,
  createArgon2idPasswordPort,
  createPasswordPort,
  createScryptPasswordPort,
  createTestPasswordPort,
} from "./password.js";

test("Argon2id defaults match documented counter-PC profile", () => {
  assert.equal(ARGON2ID_DEFAULTS.memoryCost, 19_456);
  assert.equal(ARGON2ID_DEFAULTS.timeCost, 2);
  assert.equal(ARGON2ID_DEFAULTS.parallelism, 1);
});

test("createPasswordPort hashes with Argon2id PHC and verifies", async () => {
  const port = createPasswordPort();
  const hash = await port.hashPassword("demo-password");
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(await port.verifyPassword("demo-password", hash), true);
  assert.equal(await port.verifyPassword("wrong", hash), false);
});

test("createPasswordPort verifies legacy scrypt hashes", async () => {
  const scrypt = createScryptPasswordPort();
  const legacy = await scrypt.hashPassword("legacy-secret");
  assert.match(legacy, /^scrypt\$/);

  const port = createPasswordPort();
  assert.equal(await port.verifyPassword("legacy-secret", legacy), true);
  assert.equal(await port.verifyPassword("nope", legacy), false);
});

test("createArgon2idPasswordPort rejects non-argon hashes on verify", async () => {
  const port = createArgon2idPasswordPort();
  assert.equal(await port.verifyPassword("x", "scrypt$1$1$1$a$b"), false);
});

test("createTestPasswordPort is deterministic", async () => {
  const port = createTestPasswordPort();
  const a = await port.hashPassword("abc");
  const b = await port.hashPassword("abc");
  assert.equal(a, b);
  assert.equal(await port.verifyPassword("abc", a), true);
});

test("empty password is rejected on hash", async () => {
  const port = createPasswordPort();
  await assert.rejects(() => port.hashPassword(""), /password length/);
});
