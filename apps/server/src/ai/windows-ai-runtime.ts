import { randomBytes } from "node:crypto";
import { createWindowsDpapiKms } from "./windows-dpapi-kms.js";
import type { ByokKmsPort } from "./byok-kms.js";

/** A failed OS custody check disables AI while leaving ordinary laundry operations available. */
export async function windowsAiRuntimeOptions(
  input: Readonly<{
    platform: NodeJS.Platform;
    mode: string;
    listenHost: string;
  }>,
): Promise<Readonly<{ byokKms?: ByokKmsPort; enableLocalAi?: true }>> {
  if (input.platform !== "win32" || input.mode !== "pg" || input.listenHost !== "127.0.0.1")
    return {};
  const kms = createWindowsDpapiKms();
  const challenge = randomBytes(32);
  let unwrapped: Buffer | undefined;
  try {
    const context = {
      orgId: "00000000-0000-4000-8000-000000000001",
      providerCode: "startup-check",
      credentialId: "00000000-0000-4000-8000-000000000002",
      envelopeSchemaVersion: 1 as const,
    };
    const wrapped = await kms.wrapDataKey({ plaintextKey: challenge, context });
    unwrapped = await kms.unwrapDataKey({
      wrappedKey: wrapped.wrappedKey,
      keyId: wrapped.keyId,
      keyVersion: wrapped.keyVersion,
      context,
    });
    if (!unwrapped.equals(challenge)) throw new Error("WINDOWS_DPAPI_UNAVAILABLE");
    return Object.freeze({ byokKms: kms, enableLocalAi: true as const });
  } catch {
    process.stderr.write("local AI custody check failed: WINDOWS_DPAPI_UNAVAILABLE\n");
    return Object.freeze({});
  } finally {
    challenge.fill(0);
    unwrapped?.fill(0);
  }
}
