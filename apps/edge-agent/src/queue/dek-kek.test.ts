import assert from "node:assert/strict";
import test from "node:test";

import { buffersEqual, randomKey } from "./crypto.js";
import {
  generateDek,
  MemoryKekStore,
  rewrapDek,
  UnimplementedOsKekStore,
  unwrapDek,
  wrapDek,
} from "./dek-kek.js";
import { QueueCryptoError } from "./types.js";

test("wrap/unwrap DEK with KEK round-trip", () => {
  const dek = generateDek();
  const kek = randomKey();
  const wrapped = wrapDek(dek, kek, 1);
  assert.equal(wrapped.algorithm, "AES-256-GCM");
  assert.equal(wrapped.keyVersion, 1);
  const opened = unwrapDek(wrapped, kek);
  assert.ok(buffersEqual(opened, dek));
});

test("wrong KEK cannot unwrap DEK (fail closed)", () => {
  const wrapped = wrapDek(generateDek(), randomKey(), 1);
  assert.throws(
    () => unwrapDek(wrapped, randomKey()),
    (err: unknown) => err instanceof QueueCryptoError && err.code === "auth_tag_invalid",
  );
});

test("MemoryKekStore generate/save/load/clear", () => {
  const store = new MemoryKekStore();
  const kek = store.getOrCreateKek();
  assert.equal(store.getOrCreateKek(), kek);
  const dek = generateDek();
  store.saveWrappedDek(wrapDek(dek, kek, 3));
  const loaded = store.loadWrappedDek();
  assert.ok(loaded);
  assert.equal(loaded.keyVersion, 3);
  assert.ok(buffersEqual(unwrapDek(loaded, kek), dek));
  store.clear();
  assert.equal(store.loadWrappedDek(), null);
});

test("KEK rotate rewraps DEK without changing DEK bytes", () => {
  const dek = generateDek();
  const oldKek = randomKey();
  const newKek = randomKey();
  const wrapped = wrapDek(dek, oldKek, 1);
  const rewrapped = rewrapDek(wrapped, oldKek, newKek, 2);
  assert.equal(rewrapped.keyVersion, 2);
  assert.ok(buffersEqual(unwrapDek(rewrapped, newKek), dek));
  assert.throws(() => unwrapDek(rewrapped, oldKek), QueueCryptoError);
});

test("UnimplementedOsKekStore refuses native ops (CI-safe stub)", () => {
  const store = new UnimplementedOsKekStore();
  assert.throws(() => store.getOrCreateKek(), /keytar\/DPAPI/u);
  assert.throws(() => store.loadWrappedDek(), /keytar\/DPAPI/u);
  assert.throws(() => store.saveWrappedDek(wrapDek(generateDek(), randomKey(), 1)), /keytar/u);
  assert.throws(() => store.clear(), /keytar\/DPAPI/u);
});
