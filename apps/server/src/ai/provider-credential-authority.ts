import type { TenantContext } from "../db/types.js";
import { decryptCredential } from "./byok-envelope.js";
import type { ByokRuntime } from "./byok-runtime.js";
import type { CredentialStatus } from "./byok-types.js";
import type { ProviderCredentialAuthority } from "./provider-types.js";

type SecretLoader = () => Promise<Buffer>;

/** The callback is the only plaintext boundary; every lease is zeroed in finally. */
export function createEphemeralCredentialAuthority(
  loadSecret: SecretLoader,
): ProviderCredentialAuthority {
  return Object.freeze({
    async run<T>(operation: (credential: Buffer) => Promise<T>): Promise<T> {
      const secret = await loadSecret();
      try {
        return await operation(secret);
      } finally {
        secret.fill(0);
      }
    },
    async *stream<T>(operation: (credential: Buffer) => AsyncIterable<T>): AsyncIterable<T> {
      const secret = await loadSecret();
      try {
        yield* operation(secret);
      } finally {
        secret.fill(0);
      }
    },
  });
}

export function createByokCredentialAuthority(
  input: Readonly<{
    runtime: ByokRuntime;
    tenant: TenantContext;
    providerCode: string;
    credentialRef: string;
    expectedCredentialVersion: number;
    allowedStatuses?: readonly CredentialStatus[];
  }>,
): ProviderCredentialAuthority {
  const allowed = new Set(input.allowedStatuses ?? ["active"]);
  return createEphemeralCredentialAuthority(async () => {
    const kms = input.runtime.kms;
    if (kms === null) throw new Error("AI_CREDENTIAL_UNAVAILABLE");
    const record = await input.runtime.store.findCredential(input.credentialRef, {
      tenant: input.tenant,
    });
    if (
      record === null ||
      record.providerCode !== input.providerCode ||
      record.credentialVersion !== input.expectedCredentialVersion ||
      !allowed.has(record.status)
    ) {
      throw new Error("AI_CREDENTIAL_STALE");
    }
    return decryptCredential(
      kms,
      {
        orgId: input.tenant.orgId,
        providerCode: record.providerCode,
        credentialId: record.id,
      },
      record.envelope,
    );
  });
}
