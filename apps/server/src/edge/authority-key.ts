import { createPrivateKey, createPublicKey, hkdfSync, type KeyObject } from "node:crypto";

const ED25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const KDF_SALT = Buffer.from("laundry.local.edge-authority.signer.v1", "utf8");
const KDF_INFO = Buffer.from("ed25519-pkcs8-seed", "utf8");

/**
 * Domain-separated local signer derived from the required runtime secret.
 * It stays stable across restarts without introducing another plaintext key
 * file; rotating the access-token secret intentionally rotates this trust root.
 */
export function deriveEdgeAuthorityKeyPair(secret: string): Readonly<{
  publicKey: KeyObject;
  privateKey: KeyObject;
}> {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new TypeError("Edge authority derivation requires a strong secret");
  }
  const seed = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), KDF_SALT, KDF_INFO, 32));
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  seed.fill(0);
  return Object.freeze({ privateKey, publicKey: createPublicKey(privateKey) });
}
