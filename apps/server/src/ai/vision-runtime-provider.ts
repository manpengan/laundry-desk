import { z } from "zod";
import type { ByokRuntime } from "./byok-runtime.js";
import { activeCredential, readRuntimeConfig } from "./runtime-config-service.js";
import { createRuntimeProviderResolver } from "./runtime-provider.js";
import { createByokCredentialAuthority } from "./provider-credential-authority.js";
import { credentialText } from "./provider-adapter-shared.js";
import {
  createPinnedProviderHttp,
  readProviderJson,
  type ProviderHttpPort,
} from "./provider-http.js";
import type { AiRequestContext } from "./streaming-store.js";
import type { AiProviderPort } from "./streaming-provider.js";

const AnthropicCapabilities = z
  .object({
    type: z.literal("model"),
    capabilities: z
      .object({
        image_input: z.object({ supported: z.literal(true) }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();
// Official model card explicitly lists Image input (ADR-83); unknown models fail closed.
const GEMINI_VISION_MODELS = new Set(["gemini-3.8-flash"]);
export type VisionProviderResolver = (
  context: AiRequestContext,
  signal: AbortSignal,
) => Promise<AiProviderPort>;

export function createRuntimeVisionProviderResolver(
  runtime: ByokRuntime,
  http?: ProviderHttpPort,
): VisionProviderResolver {
  return async (context, signal) => {
    const config = await readRuntimeConfig(runtime, context);
    if (
      config === null ||
      !config.enabled ||
      !context.permissions?.includes("ai_use") ||
      config.provider_code === "deepseek" ||
      !/^[A-Za-z0-9._-]{1,128}$/u.test(config.model_id)
    )
      throw new Error("AI_VISION_UNAVAILABLE");
    const models = await runtime.store.listModels({ tenant: context.tenant });
    const registered = models.some(
      (row) =>
        row.provider_code === config.provider_code &&
        row.model_id === config.model_id &&
        row.status === "available" &&
        row.supports_vision,
    );
    if (
      !registered &&
      config.provider_code === "gemini" &&
      !GEMINI_VISION_MODELS.has(config.model_id)
    )
      throw new Error("AI_VISION_UNAVAILABLE");
    if (!registered && config.provider_code === "anthropic") {
      const credential = await activeCredential(runtime, context, config.provider_code);
      const authority = createByokCredentialAuthority({
        runtime,
        tenant: context.tenant,
        providerCode: config.provider_code,
        credentialRef: credential.credential_ref,
        expectedCredentialVersion: credential.credential_version,
      });
      const client = http ?? createPinnedProviderHttp(["api.anthropic.com"]);
      await authority.run(async (key) => {
        const response = await client.request({
          url: `https://api.anthropic.com/v1/models/${encodeURIComponent(config.model_id)}`,
          method: "GET",
          headers: { "x-api-key": credentialText(key), "anthropic-version": "2023-06-01" },
          signal,
          timeoutMs: 5000,
        });
        AnthropicCapabilities.parse(await readProviderJson(response, 32_768));
      });
    }
    const provider = await createRuntimeProviderResolver(runtime, http)(context);
    if (provider === null || (provider.kind !== "anthropic" && provider.kind !== "gemini"))
      throw new Error("AI_VISION_UNAVAILABLE");
    return Object.freeze({
      kind: provider.kind,
      async *stream(request) {
        const current = await readRuntimeConfig(runtime, context);
        if (current?.version !== config.version || !current.enabled || signal.aborted)
          throw new Error("AI_VISION_UNAVAILABLE");
        yield* provider.stream(request);
      },
    });
  };
}
