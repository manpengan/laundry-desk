import type { ActorContext } from "../bus/types.js";
import type { TenantContext } from "../db/types.js";
import {
  decryptApiKey,
  encryptApiKey,
  newAiCredentialId,
  type AiCredentialMetadata,
  type AiCredentialStore,
  type KekProvider,
} from "./byok-store.js";
import {
  createReadonlyAiGateway,
  type AiGatewayEvent,
  type AiPreset,
  type AiQueryExecutor,
  type ReadonlyAiGateway,
} from "./gateway.js";
import type { AiProvider } from "./providers/types.js";

export type AiService = Readonly<{
  isConfigured: () => boolean;
  saveCredential: (
    tenant: TenantContext,
    input: Readonly<{ provider: "openai"; api_key: string }>,
  ) => Promise<AiCredentialMetadata | null>;
  listCredentials: (tenant: TenantContext) => Promise<readonly AiCredentialMetadata[]>;
  verifyCredential: (
    tenant: TenantContext,
    credentialId: string,
  ) => Promise<Readonly<{ found: boolean; verified: boolean }>>;
  stream: (
    input: Readonly<{
      tenant: TenantContext;
      actor: ActorContext;
      credential_id: string;
      preset: AiPreset;
      message: string;
      executeQuery: AiQueryExecutor;
    }>,
  ) => AsyncIterable<AiGatewayEvent>;
}>;

type AiServiceOptions = Readonly<{
  credentialStore: AiCredentialStore;
  kekProvider: KekProvider | null;
  provider: AiProvider;
  gateway?: ReadonlyAiGateway;
}>;

function findMetadata(
  list: readonly AiCredentialMetadata[],
  credentialId: string,
): AiCredentialMetadata | null {
  return list.find((item) => item.credential_id === credentialId) ?? null;
}

async function* emptyStream(): AsyncGenerator<AiGatewayEvent> {
  yield Object.freeze({ type: "error" as const, code: "RESOURCE_UNAVAILABLE" as const });
}

/** Security boundary for BYOK setup. KEK is injected by KMS/OS secret integration, never from HTTP. */
export function createAiService(options: AiServiceOptions): AiService {
  const gateway = options.gateway ?? createReadonlyAiGateway({ provider: options.provider });
  return Object.freeze({
    isConfigured: () => options.kekProvider !== null,
    async saveCredential(tenant, input) {
      if (options.kekProvider === null) return null;
      const encrypted = encryptApiKey({
        apiKey: input.api_key,
        credentialId: newAiCredentialId(),
        orgId: tenant.orgId,
        provider: input.provider,
        kekProvider: options.kekProvider,
      });
      await options.credentialStore.save(tenant, encrypted);
      return findMetadata(await options.credentialStore.list(tenant), encrypted.credential_id);
    },
    async listCredentials(tenant) {
      return options.credentialStore.list(tenant);
    },
    async verifyCredential(tenant, credentialId) {
      if (options.kekProvider === null) return Object.freeze({ found: false, verified: false });
      const credential = await options.credentialStore.get(tenant, credentialId);
      if (credential === null) return Object.freeze({ found: false, verified: false });
      let verified = false;
      try {
        const apiKey = decryptApiKey({
          credential,
          orgId: tenant.orgId,
          provider: credential.provider,
          kekProvider: options.kekProvider,
        });
        const result = await options.provider.verifyKey({
          provider: credential.provider,
          api_key: apiKey,
        });
        verified = result.ok;
      } catch {
        verified = false;
      }
      await options.credentialStore.setStatus(
        tenant,
        credentialId,
        verified ? "verified" : "invalid",
      );
      return Object.freeze({ found: true, verified });
    },
    async *stream(input) {
      if (options.kekProvider === null) {
        yield* emptyStream();
        return;
      }
      const credential = await options.credentialStore.get(input.tenant, input.credential_id);
      if (credential === null || credential.status !== "verified") {
        yield* emptyStream();
        return;
      }
      try {
        const apiKey = decryptApiKey({
          credential,
          orgId: input.tenant.orgId,
          provider: credential.provider,
          kekProvider: options.kekProvider,
        });
        yield* gateway.stream({
          tenant: input.tenant,
          actor: input.actor,
          credential: { provider: credential.provider, api_key: apiKey },
          preset: input.preset,
          message: input.message,
          executeQuery: input.executeQuery,
        });
      } catch {
        yield* emptyStream();
      }
    },
  });
}
