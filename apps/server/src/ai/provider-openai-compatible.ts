import { z } from "zod";

import {
  PROVIDER_TIMEOUT_MS,
  boundedModels,
  credentialText,
  fromExternalToolName,
  normalizeProviderError,
  parseToolArguments,
  providerErrorEvent,
  toExternalToolName,
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

const MODELS_URL = "https://api.deepseek.com/v1/models";
const CHAT_URL = "https://api.deepseek.com/v1/chat/completions";

const ModelsSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(
      z.object({ id: ProviderModelIdSchema, object: z.literal("model") }).passthrough(),
    ),
  })
  .passthrough();

const StreamChunkSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            delta: z
              .object({
                content: z.string().nullable().optional(),
                tool_calls: z
                  .array(
                    z
                      .object({
                        index: z.number().int().nonnegative(),
                        id: z.string().min(1).max(256).optional(),
                        function: z
                          .object({
                            name: z.string().min(1).max(128).optional(),
                            arguments: z.string().max(65_536).optional(),
                          })
                          .optional(),
                      })
                      .passthrough(),
                  )
                  .max(4)
                  .optional(),
              })
              .passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .max(4),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

function mapMessages(messages: readonly AiProviderMessage[]): readonly unknown[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      if (message.toolCallId === undefined) {
        throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
      }
      toExternalToolName(message.toolName);
      return Object.freeze({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      });
    }
    if (message.role === "assistant" && message.toolCallId !== undefined) {
      const toolName = toExternalToolName(message.toolName);
      return Object.freeze({
        role: "assistant",
        content: message.content || null,
        tool_calls: Object.freeze([
          {
            id: message.toolCallId,
            type: "function",
            function: {
              name: toolName,
              arguments: JSON.stringify(message.toolArgs ?? {}),
            },
          },
        ]),
      });
    }
    return Object.freeze({ role: message.role, content: message.content });
  });
}

function requestBody(modelId: string, request: AiProviderRequest): string {
  const tools = request.tools.map((tool) => ({
    type: "function",
    function: {
      name: toExternalToolName(tool.name),
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
  return JSON.stringify({
    model: modelId,
    messages: mapMessages(request.messages),
    ...(tools.length === 0 ? {} : { tools, tool_choice: "auto" }),
    max_tokens: request.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  });
}

async function* streamWithCredential(
  http: ProviderHttpPort,
  credential: Buffer,
  modelId: string,
  request: AiProviderRequest,
): AsyncIterable<AiProviderEvent> {
  const response = await http.request({
    url: CHAT_URL,
    method: "POST",
    headers: {
      authorization: `Bearer ${credentialText(credential)}`,
      "content-type": "application/json",
    },
    body: requestBody(modelId, request),
    signal: request.signal,
    timeoutMs: PROVIDER_TIMEOUT_MS,
  });
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let finishReason = "";
  let callId = "";
  let callName = "";
  let callArgs = "";
  for await (const raw of readProviderSse(response)) {
    const chunk = StreamChunkSchema.parse(raw);
    if (chunk.usage !== null && chunk.usage !== undefined) {
      inputTokens = chunk.usage.prompt_tokens;
      outputTokens = chunk.usage.completion_tokens;
    }
    const choice = chunk.choices[0];
    if (choice === undefined) continue;
    if (choice.delta.content) yield Object.freeze({ type: "delta", text: choice.delta.content });
    if (choice.finish_reason) finishReason = choice.finish_reason;
    for (const toolCall of choice.delta.tool_calls ?? []) {
      if (toolCall.index !== 0) throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
      callId = toolCall.id ?? callId;
      callName = toolCall.function?.name ?? callName;
      callArgs += toolCall.function?.arguments ?? "";
    }
  }
  if (inputTokens === null || outputTokens === null) {
    throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
  }
  const hasTool = callId !== "" || callName !== "" || callArgs !== "";
  let toolEvent: Extract<AiProviderEvent, { type: "tool_call" }> | null = null;
  if (hasTool) {
    if (callId === "") {
      throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
    }
    const toolName = fromExternalToolName(callName);
    if (!request.tools.some((tool) => tool.name === toolName)) {
      throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
    }
    toolEvent = Object.freeze({
      type: "tool_call",
      callId,
      name: toolName,
      args: parseToolArguments(callArgs),
    });
  }
  if (finishReason === "" || (hasTool ? finishReason !== "tool_calls" : finishReason !== "stop")) {
    throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
  }
  if (toolEvent !== null) yield toolEvent;
  yield Object.freeze({
    type: "end",
    finishReason: hasTool ? "tool_calls" : "stop",
    inputTokens,
    outputTokens,
  });
}

export function createDeepSeekAdapter(
  input: Readonly<{
    modelId: string;
    credentialAuthority: ProviderCredentialAuthority;
    http: ProviderHttpPort;
  }>,
): ProviderAdapter {
  const modelId = ProviderModelIdSchema.parse(input.modelId);
  return Object.freeze({
    kind: "openai_compatible" as const,
    providerCode: "deepseek" as const,
    modelId,
    async discoverModels(signal) {
      try {
        return await input.credentialAuthority.run(async (credential) => {
          const response = await input.http.request({
            url: MODELS_URL,
            method: "GET",
            headers: { authorization: `Bearer ${credentialText(credential)}` },
            signal,
            timeoutMs: PROVIDER_TIMEOUT_MS,
          });
          const body = ModelsSchema.parse(await readProviderJson(response));
          const models = boundedModels(body.data, (row) => ({
            modelId: row.id,
            displayName: row.id,
          }));
          return Object.freeze({
            providerCode: "deepseek" as const,
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
