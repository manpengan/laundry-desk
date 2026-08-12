import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { ByokKmsContext, ByokKmsPort } from "./byok-kms.js";

function aad(context: ByokKmsContext): Buffer {
  return Buffer.from(
    `${context.orgId}|${context.providerCode}|${context.credentialId}|${context.envelopeSchemaVersion}`,
    "utf8",
  );
}

/** Test-only in-memory KMS. Production code must inject an HSM/OS-backed adapter. */
export class TestByokKms implements ByokKmsPort {
  private readonly keys = new Map<string, Buffer>();
  private activeVersion: string;

  constructor(
    private readonly keyId = "test-only-kms-key",
    initialVersion = "v1",
    initialKey: Buffer = randomBytes(32),
  ) {
    if (initialKey.byteLength !== 32) throw new TypeError("Test KMS key must be 32 bytes");
    this.activeVersion = initialVersion;
    this.keys.set(initialVersion, Buffer.from(initialKey));
  }

  rotate(version: string, key: Buffer = randomBytes(32)): void {
    if (version.length < 1 || key.byteLength !== 32 || this.keys.has(version)) {
      throw new TypeError("Invalid test KMS rotation");
    }
    this.keys.set(version, Buffer.from(key));
    this.activeVersion = version;
  }

  async wrapDataKey(input: { readonly plaintextKey: Buffer; readonly context: ByokKmsContext }) {
    const key = this.keys.get(this.activeVersion);
    if (key === undefined || input.plaintextKey.byteLength !== 32) {
      throw new Error("Test KMS unavailable");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(input.context));
    const ciphertext = Buffer.concat([cipher.update(input.plaintextKey), cipher.final()]);
    return Object.freeze({
      wrappedKey: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]),
      keyId: this.keyId,
      keyVersion: this.activeVersion,
    });
  }

  async unwrapDataKey(input: {
    readonly wrappedKey: Buffer;
    readonly keyId: string;
    readonly keyVersion: string;
    readonly context: ByokKmsContext;
  }): Promise<Buffer> {
    const key = this.keys.get(input.keyVersion);
    if (key === undefined || input.keyId !== this.keyId || input.wrappedKey.byteLength !== 60) {
      throw new Error("Test KMS key unavailable");
    }
    const nonce = input.wrappedKey.subarray(0, 12);
    const tag = input.wrappedKey.subarray(12, 28);
    const ciphertext = input.wrappedKey.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad(input.context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
