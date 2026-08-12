import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptCredential,
  encryptCredential,
  rewrapCredentialDek,
  type EnvelopeIdentity,
} from "./byok-envelope.js";
import { TestByokKms } from "./byok-test-kms.js";

const IDENTITY: EnvelopeIdentity = Object.freeze({
  orgId: "11111111-1111-4111-8111-111111111111",
  providerCode: "vendor-a",
  credentialId: "22222222-2222-4222-8222-222222222222",
});

test("AES-256-GCM envelope uses fresh DEKs/nonces, binds AAD, and zeroes input", async () => {
  const kms = new TestByokKms();
  const firstPlaintext = Buffer.from("sk-test-credential-alpha", "ascii");
  const secondPlaintext = Buffer.from("sk-test-credential-alpha", "ascii");
  const first = await encryptCredential(kms, IDENTITY, firstPlaintext);
  const second = await encryptCredential(kms, IDENTITY, secondPlaintext);

  assert.equal(firstPlaintext.equals(Buffer.alloc(firstPlaintext.length)), true);
  assert.equal(secondPlaintext.equals(Buffer.alloc(secondPlaintext.length)), true);
  assert.equal(first.nonce.byteLength, 12);
  assert.equal(first.authTag.byteLength, 16);
  assert.notDeepEqual(first.nonce, second.nonce);
  assert.notDeepEqual(first.wrappedDek, second.wrappedDek);
  assert.equal(
    (await decryptCredential(kms, IDENTITY, first)).toString("ascii"),
    "sk-test-credential-alpha",
  );

  await assert.rejects(
    decryptCredential(kms, { ...IDENTITY, orgId: "33333333-3333-4333-8333-333333333333" }, first),
  );
  await assert.rejects(
    decryptCredential(kms, IDENTITY, {
      ...first,
      ciphertext: Buffer.concat([first.ciphertext.subarray(0, -1), Buffer.from([0])]),
    }),
  );
});

test("KEK rotation rewraps only the DEK and preserves credential ciphertext", async () => {
  const kms = new TestByokKms();
  const envelope = await encryptCredential(kms, IDENTITY, Buffer.from("sk-test-credential-beta"));
  kms.rotate("v2");
  const replacement = await rewrapCredentialDek(kms, IDENTITY, envelope);
  const rotated = Object.freeze({ ...envelope, ...replacement });

  assert.deepEqual(rotated.ciphertext, envelope.ciphertext);
  assert.deepEqual(rotated.nonce, envelope.nonce);
  assert.deepEqual(rotated.authTag, envelope.authTag);
  assert.notDeepEqual(rotated.wrappedDek, envelope.wrappedDek);
  assert.equal(rotated.kmsKeyVersion, "v2");
  assert.equal(
    (await decryptCredential(kms, IDENTITY, rotated)).toString("ascii"),
    "sk-test-credential-beta",
  );
});

test("restore fails closed when the referenced KMS version is unavailable", async () => {
  const originalKms = new TestByokKms();
  const envelope = await encryptCredential(
    originalKms,
    IDENTITY,
    Buffer.from("sk-test-credential-restore"),
  );
  const restoredWithoutOldAuthority = new TestByokKms("test-only-kms-key", "v2");
  await assert.rejects(decryptCredential(restoredWithoutOldAuthority, IDENTITY, envelope));
});

test("input is zeroed when identity validation or randomness fails before encryption", async () => {
  const invalidIdentityInput = Buffer.from("sk-test-invalid-identity");
  await assert.rejects(
    encryptCredential(
      new TestByokKms(),
      { ...IDENTITY, credentialId: "not-an-opaque-ref" },
      invalidIdentityInput,
    ),
  );
  assert.deepEqual(invalidIdentityInput, Buffer.alloc(invalidIdentityInput.length));

  const randomFailureInput = Buffer.from("sk-test-random-failure");
  await assert.rejects(
    encryptCredential(new TestByokKms(), IDENTITY, randomFailureInput, () => {
      throw new Error("random source failed");
    }),
  );
  assert.deepEqual(randomFailureInput, Buffer.alloc(randomFailureInput.length));
});
