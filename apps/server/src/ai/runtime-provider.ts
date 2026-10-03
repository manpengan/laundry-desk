import type { ByokRuntime } from "./byok-runtime.js";
import { createByokCredentialAuthority } from "./provider-credential-authority.js";
import { createProviderAdapter } from "./provider-registry.js";
import type { ProviderHttpPort } from "./provider-http.js";
import type { AiProviderPort } from "./streaming-provider.js";
import type { AiRequestContext } from "./streaming-store.js";
import { activeCredential, AiConfigError, readRuntimeConfig } from "./runtime-config-service.js";

export type AiProviderResolver = (context: AiRequestContext) => Promise<AiProviderPort | null>;

/** Resolve on the server per request; recheck selection and credential before every provider call. */
export function createRuntimeProviderResolver(
  runtime: ByokRuntime,
  http?: ProviderHttpPort,
): AiProviderResolver {
  return async (context) => {
    if (runtime.kms === null || !context.permissions?.includes("ai_use")) return null;
    const config = await readRuntimeConfig(runtime, context);
    if (config === null || !config.enabled) return null;
    const credential = await activeCredential(runtime, context, config.provider_code).catch(
      (error) => {
        if (error instanceof AiConfigError && error.code === "RESOURCE_UNAVAILABLE") return null;
        throw error;
      },
    );
    if (credential === null) return null;
    const authority = createByokCredentialAuthority({
      runtime,
      tenant: context.tenant,
      providerCode: config.provider_code,
      credentialRef: credential.credential_ref,
      expectedCredentialVersion: credential.credential_version,
    });
    const assertCurrent = async () => {
      const current = await readRuntimeConfig(runtime, context);
      if (current === null || !current.enabled || current.version !== config.version) {
        throw new Error("AI_CREDENTIAL_STALE");
      }
    };
    return createProviderAdapter({
      providerCode: config.provider_code,
      modelId: config.model_id,
      credentialAuthority: {
        async run(operation) {
          await assertCurrent();
          return authority.run(operation);
        },
        async *stream(operation) {
          await assertCurrent();
          yield* authority.stream(operation);
        },
      },
      ...(http === undefined ? {} : { http }),
    });
  };
}
