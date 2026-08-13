import { z } from "zod";

import {
  EXTERNAL_TOOL_NAME,
  PROVIDER_TIMEOUT_MS,
  boundedModels,
  credentialText,
  normalizeProviderError,
  providerErrorEvent,
} from "./provider-adapter-shared.js";
import { readProviderJson, readProviderSse, type ProviderHttpPort } from "./provider-http.js";
import {
  ProviderAdapterError,
  ProviderModelIdSchema,
  type ProviderAdapter,
  type ProviderCredentialAuthority,
} from "./provider-types.js";
import type {
  AiProviderEvent,
  AiProviderMessage,
  AiProviderRequest,
} from "./streaming-provider.js";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const MODELS_URL = `${API_ROOT}/models?pageSize=200`;

const ModelsSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            name: z.string().regex(/^models\/[A-Za-z0-9._-]{1,128}$/u),
            displayName: z.string().min(1).max(128).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const StreamChunkSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            content: z
              .object({
                parts: z
                  .array(
                    z
                      .object({
                        text: z.string().optional(),
                        functionCall: z
                          .object({
                            id: z.string().min(1).max(256).optional(),
                            name: z.string().min(1).max(128),
                            args: z.record(z.string(), z.unknown()),
                          })
                          .passthrough()
                          .optional(),
                      })
                      .passthrough(),
                  )
                  .max(32),
              })
              .passthrough()
              .optional(),
            finishReason: z.string().optional(),
          })
          .passthrough(),
      )
      .max(4)
      .optional(),
    usageMetadata: z
      .object({
        promptTokenCount: z.number().int().nonnegative(),
        candidatesTokenCount: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function safeToolResult(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return Object.freeze({ result: content });
  }
}

function mapMessages(messages: readonly AiProviderMessage[]): readonly unknown[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return Object.freeze({
        role: "user",
        parts: Object.freeze([
          {
            functionResponse: {
              id: message.toolCallId,
              name: EXTERNAL_TOOL_NAME,
              response: safeToolResult(message.content),
            },
          },
        ]),
      });
    }
    if (message.role === "assistant" && message.toolCallId !== undefined) {
      return Object.freeze({
        role: "model",
        parts: Object.freeze([
          {
            functionCall: {
              id: message.toolCallId,
              name: EXTERNAL_TOOL_NAME,
              args: message.toolArgs ?? {},
            },
          },
        ]),
      });
    }
    return Object.freeze({
      role: message.role === "assistant" ? "model" : "user",
      parts: Object.freeze([{ text: message.content }]),
    });
  });
}

function headers(credential: Buffer): Readonly<Record<string, string>> {
  return Object.freeze({
    "x-goog-api-key": credentialText(credential),
    "content-type": "application/json",
  });
}

function requestBody(request: AiProviderRequest): string {
  return JSON.stringify({
    contents: mapMessages(request.messages),
    tools: [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: EXTERNAL_TOOL_NAME,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      },
    ],
    generationConfig: { maxOutputTokens: request.maxOutputTokens },
  });
}

async function* streamWithCredential(
  http: ProviderHttpPort,
  credential: Buffer,
  modelId: string,
  request: AiProviderRequest,
): AsyncIterable<AiProviderEvent> {
  const response = await http.request({
    url: `${API_ROOT}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`,
    method: "POST",
    headers: headers(credential),
    body: requestBody(request),
    signal: request.signal,
    timeoutMs: PROVIDER_TIMEOUT_MS,
  });
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let finishReason = "";
  let call: Readonly<{ id?: string; name: string; args: Record<string, unknown> }> | null = null;
  for await (const raw of readProviderSse(response)) {
    const chunk = StreamChunkSchema.parse(raw);
    if (chunk.usageMetadata !== undefined) {
      inputTokens = chunk.usageMetadata.promptTokenCount;
      outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
    }
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    for (const part of candidate?.content?.parts ?? []) {
      if (part.text) yield Object.freeze({ type: "delta", text: part.text });
      if (part.functionCall !== undefined) {
        if (call !== null) throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
        call = Object.freeze({
          ...(part.functionCall.id === undefined ? {} : { id: part.functionCall.id }),
          name: part.functionCall.name,
          args: part.functionCall.args,
        });
      }
    }
  }
  if (inputTokens === null || outputTokens === null || finishReason === "") {
    throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
  }
  if (call !== null) {
    if (call.name !== EXTERNAL_TOOL_NAME)
      throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
    yield Object.freeze({
      type: "tool_call",
      callId: call.id ?? "gemini-call-1",
      name: "synthetic.lookup",
      args: call.args,
    });
  }
  if (call === null && finishReason !== "STOP")
    throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
  yield Object.freeze({
    type: "end",
    finishReason: call === null ? "stop" : "tool_calls",
    inputTokens,
    outputTokens,
  });
}

export function createGeminiAdapter(
  input: Readonly<{
    modelId: string;
    credentialAuthority: ProviderCredentialAuthority;
    http: ProviderHttpPort;
  }>,
): ProviderAdapter {
  const modelId = ProviderModelIdSchema.parse(input.modelId);
  return Object.freeze({
    kind: "gemini" as const,
    providerCode: "gemini" as const,
    modelId,
    async discoverModels(signal) {
      try {
        return await input.credentialAuthority.run(async (credential) => {
          const response = await input.http.request({
            url: MODELS_URL,
            method: "GET",
            headers: headers(credential),
            signal,
            timeoutMs: PROVIDER_TIMEOUT_MS,
          });
          const body = ModelsSchema.parse(await readProviderJson(response));
          const models = boundedModels(body.models ?? [], (row) => {
            const id = row.name.slice("models/".length);
            return { modelId: id, displayName: row.displayName ?? id };
          });
          return Object.freeze({
            providerCode: "gemini" as const,
            models,
            selectedModelAvailable: models.some((row) => row.modelId === modelId),
          });
        });
      } catch (error) {
        throw normalizeProviderError(error);
      }
    },
    async *stream(request) {
      try {
        yield* input.credentialAuthority.stream((credential) =>
          streamWithCredential(input.http, credential, modelId, request),
        );
      } catch (error) {
        yield providerErrorEvent(error);
      }
    },
  });
}
