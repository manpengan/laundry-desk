import { z } from "zod";

import {
  EXTERNAL_TOOL_NAME,
  PROVIDER_TIMEOUT_MS,
  boundedModels,
  credentialText,
  normalizeProviderError,
  parseToolArguments,
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

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=200";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const ModelsSchema = z
  .object({
    data: z.array(
      z
        .object({
          id: ProviderModelIdSchema,
          display_name: z.string().min(1).max(128).optional(),
          type: z.literal("model"),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const EventSchema = z
  .object({
    type: z.string().min(1).max(64),
    message: z
      .object({ usage: z.object({ input_tokens: z.number().int().nonnegative() }).passthrough() })
      .passthrough()
      .optional(),
    index: z.number().int().nonnegative().optional(),
    content_block: z
      .object({
        type: z.string(),
        id: z.string().min(1).max(256).optional(),
        name: z.string().min(1).max(128).optional(),
        input: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    delta: z
      .object({
        type: z.string().optional(),
        text: z.string().optional(),
        partial_json: z.string().max(65_536).optional(),
        stop_reason: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    usage: z.object({ output_tokens: z.number().int().nonnegative() }).passthrough().optional(),
  })
  .passthrough();

function mapMessages(messages: readonly AiProviderMessage[]): readonly unknown[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return Object.freeze({
        role: "user",
        content: Object.freeze([
          { type: "tool_result", tool_use_id: message.toolCallId, content: message.content },
        ]),
      });
    }
    if (message.role === "assistant" && message.toolCallId !== undefined) {
      return Object.freeze({
        role: "assistant",
        content: Object.freeze([
          {
            type: "tool_use",
            id: message.toolCallId,
            name: EXTERNAL_TOOL_NAME,
            input: message.toolArgs ?? {},
          },
        ]),
      });
    }
    return Object.freeze({ role: message.role, content: message.content });
  });
}

function headers(credential: Buffer): Readonly<Record<string, string>> {
  return Object.freeze({
    "x-api-key": credentialText(credential),
    "anthropic-version": API_VERSION,
    "content-type": "application/json",
  });
}

function requestBody(modelId: string, request: AiProviderRequest): string {
  return JSON.stringify({
    model: modelId,
    max_tokens: request.maxOutputTokens,
    messages: mapMessages(request.messages),
    tools: request.tools.map((tool) => ({
      name: EXTERNAL_TOOL_NAME,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
    stream: true,
  });
}

async function* streamWithCredential(
  http: ProviderHttpPort,
  credential: Buffer,
  modelId: string,
  request: AiProviderRequest,
): AsyncIterable<AiProviderEvent> {
  const response = await http.request({
    url: MESSAGES_URL,
    method: "POST",
    headers: headers(credential),
    body: requestBody(modelId, request),
    signal: request.signal,
    timeoutMs: PROVIDER_TIMEOUT_MS,
  });
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let stopReason = "";
  let toolIndex: number | null = null;
  let callId = "";
  let callName = "";
  let callArgs = "";
  let stopped = false;
  for await (const raw of readProviderSse(response)) {
    const event = EventSchema.parse(raw);
    if (event.type === "message_start") inputTokens = event.message?.usage.input_tokens ?? null;
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      if (toolIndex !== null) throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
      toolIndex = event.index ?? null;
      callId = event.content_block.id ?? "";
      callName = event.content_block.name ?? "";
      if (
        event.content_block.input !== undefined &&
        JSON.stringify(event.content_block.input) !== "{}"
      ) {
        callArgs = JSON.stringify(event.content_block.input);
      }
    }
    if (
      event.type === "content_block_delta" &&
      event.delta?.type === "text_delta" &&
      event.delta.text
    ) {
      yield Object.freeze({ type: "delta", text: event.delta.text });
    }
    if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
      if (event.index !== toolIndex) throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
      callArgs += event.delta.partial_json ?? "";
    }
    if (event.type === "message_delta") {
      stopReason = event.delta?.stop_reason ?? "";
      outputTokens = event.usage?.output_tokens ?? null;
    }
    if (event.type === "message_stop") stopped = true;
    if (event.type === "error") throw new ProviderAdapterError("PROVIDER_UNAVAILABLE");
  }
  if (!stopped || inputTokens === null || outputTokens === null) {
    throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
  }
  const hasTool = toolIndex !== null;
  if (hasTool) {
    if (callId === "" || callName !== EXTERNAL_TOOL_NAME) {
      throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
    }
    yield Object.freeze({
      type: "tool_call",
      callId,
      name: "synthetic.lookup",
      args: parseToolArguments(callArgs || "{}"),
    });
  }
  if ((!hasTool && stopReason !== "end_turn") || (hasTool && stopReason !== "tool_use")) {
    throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
  }
  yield Object.freeze({
    type: "end",
    finishReason: hasTool ? "tool_calls" : "stop",
    inputTokens,
    outputTokens,
  });
}

export function createAnthropicAdapter(
  input: Readonly<{
    modelId: string;
    credentialAuthority: ProviderCredentialAuthority;
    http: ProviderHttpPort;
  }>,
): ProviderAdapter {
  const modelId = ProviderModelIdSchema.parse(input.modelId);
  return Object.freeze({
    kind: "anthropic" as const,
    providerCode: "anthropic" as const,
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
          const models = boundedModels(body.data, (row) => ({
            modelId: row.id,
            displayName: row.display_name ?? row.id,
          }));
          return Object.freeze({
            providerCode: "anthropic" as const,
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
