import { z } from "zod";

import type { AiModelMetadata } from "@laundry/contracts";

import type { AiProviderPort } from "./streaming-provider.js";

export const ProviderCodeSchema = z.enum(["deepseek", "anthropic", "gemini"]);
export type ProviderCode = z.output<typeof ProviderCodeSchema>;

export const ProviderModelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);

export type ProviderFailureCode =
  | "PROVIDER_AUTH_REJECTED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ABORTED"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_RESPONSE_TOO_LARGE"
  | "NETWORK_POLICY_DENIED"
  | "NETWORK_ERROR";

export class ProviderAdapterError extends Error {
  override readonly name = "ProviderAdapterError";

  constructor(readonly code: ProviderFailureCode) {
    super(code);
  }
}

export type ProviderCredentialAuthority = Readonly<{
  run<T>(operation: (credential: Buffer) => Promise<T>): Promise<T>;
  stream<T>(operation: (credential: Buffer) => AsyncIterable<T>): AsyncIterable<T>;
}>;

export type DiscoveredProviderModel = Readonly<{
  modelId: string;
  displayName: string;
}>;

export type ProviderConnectionValidation = Readonly<{
  providerCode: ProviderCode;
  models: readonly DiscoveredProviderModel[];
  selectedModelAvailable: boolean;
}>;

export type ProviderAdapter = AiProviderPort &
  Readonly<{
    providerCode: ProviderCode;
    modelId: string;
    discoverModels(signal: AbortSignal): Promise<ProviderConnectionValidation>;
  }>;

export type ProviderModelProjection = Readonly<{
  modelId: string;
  displayName: string;
  availability: "registered" | "discovered_unverified" | "unavailable";
  capabilities: Pick<
    AiModelMetadata,
    | "supports_streaming"
    | "supports_tools"
    | "supports_vision"
    | "max_input_tokens"
    | "max_output_tokens"
    | "registry_version"
  > | null;
}>;

export function projectProviderModels(
  discovered: readonly DiscoveredProviderModel[],
  registered: readonly AiModelMetadata[],
  providerCode: string,
): readonly ProviderModelProjection[] {
  const discoveredMap = new Map(discovered.map((model) => [model.modelId, model]));
  const registeredMap = new Map(
    registered
      .filter((model) => model.provider_code === providerCode)
      .map((model) => [model.model_id, model]),
  );
  const ids = new Set([...discoveredMap.keys(), ...registeredMap.keys()]);
  return Object.freeze(
    [...ids].sort().map((modelId) => {
      const found = discoveredMap.get(modelId);
      const registry = registeredMap.get(modelId);
      return Object.freeze({
        modelId,
        displayName: registry?.display_name ?? found?.displayName ?? modelId,
        availability:
          found !== undefined && registry !== undefined
            ? ("registered" as const)
            : found !== undefined
              ? ("discovered_unverified" as const)
              : ("unavailable" as const),
        capabilities:
          registry === undefined
            ? null
            : Object.freeze({
                supports_streaming: registry.supports_streaming,
                supports_tools: registry.supports_tools,
                supports_vision: registry.supports_vision,
                max_input_tokens: registry.max_input_tokens,
                max_output_tokens: registry.max_output_tokens,
                registry_version: registry.registry_version,
              }),
      });
    }),
  );
}
