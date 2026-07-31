import assert from "node:assert/strict";
import { sign, verify } from "node:crypto";
import test from "node:test";

import { deriveEdgeAuthorityKeyPair } from "./authority-key.js";

test("edge authority signer is deterministic and domain-separated from different secrets", () => {
  const first = deriveEdgeAuthorityKeyPair("a".repeat(64));
  const same = deriveEdgeAuthorityKeyPair("a".repeat(64));
  const different = deriveEdgeAuthorityKeyPair("b".repeat(64));
  const message = Buffer.from("edge authority", "utf8");
  const signature = sign(null, message, first.privateKey);

  assert.equal(verify(null, message, same.publicKey, signature), true);
  assert.equal(verify(null, message, different.publicKey, signature), false);
});

test("accepts a multibyte secret that satisfies the shared UTF-8 byte policy", () => {
  const keyPair = deriveEdgeAuthorityKeyPair("台".repeat(11));
  assert.equal(keyPair.publicKey.asymmetricKeyType, "ed25519");
});
