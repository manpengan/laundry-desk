import assert from "node:assert/strict";
import test from "node:test";

import {
  buffersEqual,
  decryptAes256Gcm,
  encryptAes256Gcm,
  packSealedBlob,
  randomKey,
  unpackSealedBlob,
} from "./crypto.js";
import { QueueCryptoError } from "./types.js";

test("AES-256-GCM encrypt/decrypt round-trip with AAD", () => {
  const key = randomKey();
  const aad = Buffer.from("aad-v1", "utf8");
  const plain = Buffer.from("offline queue payload", "utf8");
  const sealed = encryptAes256Gcm(key, plain, aad);
  const opened = decryptAes256Gcm(key, sealed, aad);
  assert.equal(opened.toString("utf8"), plain.toString("utf8"));
  assert.equal(sealed.nonce.length, 12);
  assert.equal(sealed.authTag.length, 16);
});

test("wrong key fails closed (auth tag invalid)", () => {
  const sealed = encryptAes256Gcm(randomKey(), Buffer.from("x"), Buffer.from("a"));
  assert.throws(
    () => decryptAes256Gcm(randomKey(), sealed, Buffer.from("a")),
    (err: unknown) => err instanceof QueueCryptoError && err.code === "auth_tag_invalid",
  );
});

test("wrong AAD fails closed", () => {
  const key = randomKey();
  const sealed = encryptAes256Gcm(key, Buffer.from("x"), Buffer.from("aad-a"));
  assert.throws(
    () => decryptAes256Gcm(key, sealed, Buffer.from("aad-b")),
    (err: unknown) => err instanceof QueueCryptoError && err.code === "auth_tag_invalid",
  );
});

test("pack/unpack sealed blob preserves components", () => {
  const key = randomKey();
  const sealed = encryptAes256Gcm(key, Buffer.from("blob"), Buffer.from("aad"));
  const packed = packSealedBlob(sealed);
  const unpacked = unpackSealedBlob(packed);
  assert.ok(buffersEqual(unpacked.nonce, sealed.nonce));
  assert.ok(buffersEqual(unpacked.authTag, sealed.authTag));
  assert.ok(buffersEqual(unpacked.ciphertext, sealed.ciphertext));
  const opened = decryptAes256Gcm(key, unpacked, Buffer.from("aad"));
  assert.equal(opened.toString("utf8"), "blob");
});

test("tampered packed blob fails closed", () => {
  const key = randomKey();
  const packed = packSealedBlob(encryptAes256Gcm(key, Buffer.from("x"), Buffer.from("a")));
  const last = packed.length - 1;
  const tail = packed[last];
  assert.ok(tail !== undefined);
  packed[last] = tail ^ 0xff;
  const sealed = unpackSealedBlob(packed);
  assert.throws(
    () => decryptAes256Gcm(key, sealed, Buffer.from("a")),
    (err: unknown) => err instanceof QueueCryptoError && err.code === "auth_tag_invalid",
  );
});
