import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { createWindowsDpapiKms, WindowsDpapiError } from "./windows-dpapi-kms.js";
import { encryptCredential, decryptCredential } from "./byok-envelope.js";
import { WINDOWS_DPAPI_SCRIPT } from "./windows-dpapi-script.js";

const context = {
  orgId: "11111111-1111-4111-8111-111111111111",
  providerCode: "deepseek",
  credentialId: "22222222-2222-4222-8222-222222222222",
  envelopeSchemaVersion: 1 as const,
};

test("DPAPI binary bridge binds envelope identity and clears every transmitted frame", async () => {
  const frames: Buffer[] = [];
  const copies: Buffer[] = [];
  const kms = createWindowsDpapiKms(async (frame) => {
    frames.push(frame);
    copies.push(Buffer.from(frame));
    return Buffer.alloc(64, 7);
  });
  const key = randomBytes(32);
  await kms.wrapDataKey({ plaintextKey: key, context });
  await kms.wrapDataKey({ plaintextKey: key, context: { ...context, providerCode: "gemini" } });
  assert.equal(copies[0]?.[0], 1);
  assert.equal(copies[0]?.readInt32LE(33), 32);
  assert.deepEqual(copies[0]?.subarray(37), key);
  assert.notDeepEqual(copies[0]?.subarray(1, 33), copies[1]?.subarray(1, 33));
  assert.ok(frames.every((frame) => frame.every((byte) => byte === 0)));
  assert.notEqual(
    key.every((byte) => byte === 0),
    true,
  );
});

test("DPAPI errors and malformed responses fail closed without leaking native details", async () => {
  let observed: Buffer | null = null;
  const kms = createWindowsDpapiKms(async (frame) => {
    observed = frame;
    throw new Error("SECRET DETAIL");
  });
  await assert.rejects(
    kms.wrapDataKey({ plaintextKey: randomBytes(32), context }),
    (error) => error instanceof WindowsDpapiError && !error.message.includes("SECRET"),
  );
  assert.deepEqual(observed, Buffer.alloc(69));
  const invalid = Buffer.alloc(40, 9);
  const malformed = createWindowsDpapiKms(async () => invalid);
  await assert.rejects(
    malformed.unwrapDataKey({
      wrappedKey: Buffer.alloc(64),
      keyId: "windows-dpapi-current-user",
      keyVersion: "1",
      context,
    }),
    WindowsDpapiError,
  );
  assert.ok(invalid.every((byte) => byte === 0));
  await assert.rejects(
    malformed.unwrapDataKey({
      wrappedKey: Buffer.alloc(64),
      keyId: "test-kms",
      keyVersion: "1",
      context,
    }),
    WindowsDpapiError,
  );
});

test("notification and AI DEKs use distinct DPAPI entropy even for the same identity", async () => {
  const entropies: Buffer[] = [];
  const transport = async (frame: Buffer) => {
    entropies.push(Buffer.from(frame.subarray(1, 33)));
    return Buffer.alloc(64);
  };
  const plaintextKey = randomBytes(32);
  await createWindowsDpapiKms(transport, "ai").wrapDataKey({ plaintextKey, context });
  await createWindowsDpapiKms(transport, "notification").wrapDataKey({ plaintextKey, context });
  assert.notDeepEqual(entropies[0], entropies[1]);
});

test("DPAPI static program checks trusted OS ACL before consuming bounded binary input", () => {
  assert.ok(
    WINDOWS_DPAPI_SCRIPT.indexOf("GetAccessControl") <
      WINDOWS_DPAPI_SCRIPT.indexOf("OpenStandardInput"),
  );
  assert.match(WINDOWS_DPAPI_SCRIPT, /DataProtectionScope\]::CurrentUser/u);
  assert.match(WINDOWS_DPAPI_SCRIPT, /ReparsePoint/u);
  assert.match(WINDOWS_DPAPI_SCRIPT, /16384/u);
  assert.doesNotMatch(
    WINDOWS_DPAPI_SCRIPT,
    /Invoke-Expression|Start-Process|LocalMachine|WriteAll/u,
  );
});

test(
  "Windows native DPAPI survives KMS instance restart and rejects another identity",
  { skip: process.platform !== "win32" },
  async () => {
    const secret = Buffer.from("native-acceptance-synthetic-api-key");
    const envelope = await encryptCredential(createWindowsDpapiKms(), context, secret);
    assert.ok(secret.every((byte) => byte === 0));
    const reopened = await decryptCredential(createWindowsDpapiKms(), context, envelope);
    assert.equal(reopened.toString(), "native-acceptance-synthetic-api-key");
    reopened.fill(0);
    await assert.rejects(
      decryptCredential(createWindowsDpapiKms(), { ...context, providerCode: "gemini" }, envelope),
    );
  },
);
