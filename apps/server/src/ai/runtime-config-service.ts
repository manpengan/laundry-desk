import { randomUUID } from "node:crypto";
import {
  AiRuntimeConfigRequestSchema,
  AiRuntimeConfigSchema,
  type AiRuntimeConfig,
} from "@laundry/contracts";
import type { AuthorizedSession } from "../auth/session-view.js";
import { permissionsForAuthority } from "../bus/runtime.js";
import type { ByokRuntime } from "./byok-runtime.js";
import { requesterAuthorityIsCurrent } from "./byok-requester-authority.js";
import { createByokCredentialAuthority } from "./provider-credential-authority.js";
import { createProviderAdapter } from "./provider-registry.js";
import type { ProviderHttpPort } from "./provider-http.js";
import type { AiRequestContext } from "./streaming-store.js";

export class AiConfigError extends Error {
  constructor(readonly code: "RESOURCE_UNAVAILABLE" | "POLICY_DENIED" | "IDEMPOTENCY_CONFLICT") {
    super(code);
    this.name = "AiConfigError";
  }
}

export async function readRuntimeConfig(
  runtime: ByokRuntime,
  context: AiRequestContext,
): Promise<AiRuntimeConfig | null> {
  if (runtime.local.pool === null) return null;
  return runtime.transact(context.tenant, async ({ client }) => {
    await client.query("SELECT set_config('app.auth_session_id', $1, true)", [
      context.authSessionId,
    ]);
    const result = await client.query<{ config: unknown }>(
      "SELECT public.ai_runtime_config_get($1::uuid) AS config",
      [context.authSessionId],
    );
    const config = result.rows[0]?.config;
    return config === null || config === undefined ? null : AiRuntimeConfigSchema.parse(config);
  });
}

export function aiContext(authorized: AuthorizedSession): AiRequestContext {
  return Object.freeze({
    tenant: Object.freeze({
      orgId: authorized.session.org_id,
      storeId: authorized.session.store_id,
      staffId: authorized.session.staff_id,
    }),
    authSessionId: authorized.session.session_id,
    deviceId: authorized.session.device_id,
    permissions: permissionsForAuthority(authorized.authority),
  });
}

export async function activeCredential(
  runtime: ByokRuntime,
  context: AiRequestContext,
  providerCode: string,
) {
  const records = await runtime.store.listCredentialMetadata({ tenant: context.tenant });
  const matches = records.filter(
    (row) => row.provider_code === providerCode && row.status === "active",
  );
  if (matches.length !== 1 || matches[0] === undefined)
    throw new AiConfigError("RESOURCE_UNAVAILABLE");
  return matches[0];
}

export function createAiRuntimeConfigService(runtime: ByokRuntime, http?: ProviderHttpPort) {
  const read = async (authorized: AuthorizedSession) =>
    Object.freeze({
      config: await readRuntimeConfig(runtime, aiContext(authorized)),
      custody_available: runtime.kms !== null && runtime.local.pool !== null,
    });
  return Object.freeze({
    read,
    async save(authorized: AuthorizedSession, raw: unknown, signal: AbortSignal) {
      const input = AiRuntimeConfigRequestSchema.parse(raw);
      if (runtime.local.pool === null || runtime.kms === null)
        throw new AiConfigError("RESOURCE_UNAVAILABLE");
      const context = aiContext(authorized);
      // Enabling or changing models performs an explicit bounded model-discovery request.
      if (input.enabled) {
        const credential = await activeCredential(runtime, context, input.provider_code);
        const adapter = createProviderAdapter({
          providerCode: input.provider_code,
          modelId: input.model_id,
          credentialAuthority: createByokCredentialAuthority({
            runtime,
            tenant: context.tenant,
            providerCode: input.provider_code,
            credentialRef: credential.credential_ref,
            expectedCredentialVersion: credential.credential_version,
          }),
          ...(http === undefined ? {} : { http }),
        });
        if (!(await adapter.discoverModels(signal)).selectedModelAvailable)
          throw new AiConfigError("RESOURCE_UNAVAILABLE");
      }
      const config = await runtime.transact(context.tenant, async (transaction) => {
        if (!(await requesterAuthorityIsCurrent(runtime, authorized, transaction)))
          throw new AiConfigError("POLICY_DENIED");
        await transaction.client.query("SELECT set_config('app.auth_session_id', $1, true)", [
          context.authSessionId,
        ]);
        try {
          const result = await transaction.client.query<{ config: unknown }>(
            "SELECT public.ai_runtime_config_set($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::uuid) AS config",
            [
              context.authSessionId,
              input.expected_version,
              input.provider_code,
              input.model_id,
              input.enabled,
              input.monthly_limit_micros,
              input.input_micros_per_million,
              input.output_micros_per_million,
              randomUUID(),
            ],
          );
          return AiRuntimeConfigSchema.parse(result.rows[0]?.config);
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "40001"
          ) {
            throw new AiConfigError("IDEMPOTENCY_CONFLICT");
          }
          throw error;
        }
      });
      return Object.freeze({ config, custody_available: true });
    },
  });
}
