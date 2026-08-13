import { createAnthropicAdapter } from "./provider-anthropic.js";
import { createGeminiAdapter } from "./provider-gemini.js";
import { createPinnedProviderHttp, type ProviderHttpPort } from "./provider-http.js";
import { createDeepSeekAdapter } from "./provider-openai-compatible.js";
import {
  ProviderCodeSchema,
  type ProviderAdapter,
  type ProviderCode,
  type ProviderCredentialAuthority,
} from "./provider-types.js";

export const AI_PROVIDER_CATALOG = Object.freeze([
  Object.freeze({
    providerCode: "deepseek" as const,
    displayName: "DeepSeek",
    adapterFamily: "openai_compatible" as const,
    baseUrl: "https://api.deepseek.com/v1",
    allowedHosts: Object.freeze(["api.deepseek.com"]),
  }),
  Object.freeze({
    providerCode: "anthropic" as const,
    displayName: "Anthropic",
    adapterFamily: "anthropic" as const,
    baseUrl: "https://api.anthropic.com/v1",
    allowedHosts: Object.freeze(["api.anthropic.com"]),
  }),
  Object.freeze({
    providerCode: "gemini" as const,
    displayName: "Google Gemini",
    adapterFamily: "gemini" as const,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    allowedHosts: Object.freeze(["generativelanguage.googleapis.com"]),
  }),
]);

export function createProviderAdapter(
  input: Readonly<{
    providerCode: ProviderCode;
    modelId: string;
    credentialAuthority: ProviderCredentialAuthority;
    http?: ProviderHttpPort;
  }>,
): ProviderAdapter {
  const providerCode = ProviderCodeSchema.parse(input.providerCode);
  const catalog = AI_PROVIDER_CATALOG.find((row) => row.providerCode === providerCode);
  if (catalog === undefined) throw new TypeError("Unsupported AI provider");
  const http = input.http ?? createPinnedProviderHttp(catalog.allowedHosts);
  const common = Object.freeze({
    modelId: input.modelId,
    credentialAuthority: input.credentialAuthority,
    http,
  });
  if (providerCode === "deepseek") return createDeepSeekAdapter(common);
  if (providerCode === "anthropic") return createAnthropicAdapter(common);
  return createGeminiAdapter(common);
}
