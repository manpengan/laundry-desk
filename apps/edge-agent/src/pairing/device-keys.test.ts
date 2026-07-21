import assert from "node:assert/strict";
import { verify } from "node:crypto";
import test from "node:test";

import {
  MemoryDeviceKeyStore,
  UnimplementedOsDeviceKeyStore,
  importPublicKeySpkiBase64Url,
} from "./device-keys.js";

test("MemoryDeviceKeyStore generate/load/clear round-trip", () => {
  const store = new MemoryDeviceKeyStore();
  assert.equal(store.load(), null);
  const material = store.generate();
  assert.equal(store.load(), material);
  const exported = material.exportPublic();
  assert.equal(exported.algorithm, "Ed25519");
  assert.ok(exported.publicKeySpkiBase64Url.length > 40);
  store.clear();
  assert.equal(store.load(), null);
});

test("device key can sign and verify with exported public key", () => {
  const store = new MemoryDeviceKeyStore();
  const material = store.generate();
  const message = new TextEncoder().encode("laundry.edge.test");
  const signature = material.signBytes(message);
  const publicKey = importPublicKeySpkiBase64Url(material.exportPublic().publicKeySpkiBase64Url);
  assert.equal(verify(null, message, publicKey, signature), true);
});

test("UnimplementedOsDeviceKeyStore refuses native ops (CI-safe stub)", () => {
  const store = new UnimplementedOsDeviceKeyStore();
  assert.throws(() => store.generate(), /keytar\/DPAPI/u);
  assert.throws(() => store.load(), /keytar\/DPAPI/u);
  assert.throws(() => store.clear(), /keytar\/DPAPI/u);
});
