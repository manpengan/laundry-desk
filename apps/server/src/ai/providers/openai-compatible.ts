import { z } from "zod";

import {
  AiProviderChatInputSchema,
  AiProviderEventSchema,
  type AiProvider,
  type AiProviderChatInput,
  type AiToolCall,
} from "./types.js";

const OPENAI_API_ORIGIN = "https://api.openai.com";
const CHAT_PATH = "/v1/chat/completions";
const VERIFY_PATH = "/v1/models";

const OpenAiChunkSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            delta: z
              .object({
                content: z.string().optional(),
                tool_calls: z
                  .array(
                    z
                      .object({
                        index: z.number().int().nonnegative(),
                        id: z.string().optional(),
                        function: z
                          .object({ name: z.string().optional(), arguments: z.string().optional() })
                          .optional(),
                      })
                      .strict(),
                  )
                  .optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(1),
  })
  .strict();

type FetchPort = typeof fetch;
type PartialCall = Readonly<{ id?: string; name?: string; argumentsJson: string }>;

function officialUrl(path: string): URL {
  return new URL(path, OPENAI_API_ORIGIN);
}

function toolWireShape(input: AiProviderChatInput): readonly Record<string, unknown>[] {
  return input.tools.map((tool) =>
    Object.freeze({
      type: "function",
      function: Object.freeze({
        name: tool.name,
        description: tool.description,
        parameters: tool.input_json_schema,
        strict: true,
      }),
    }),
  );
}

function messageWireShape(input: AiProviderChatInput): readonly Record<string, unknown>[] {
  return input.messages.map((message) => {
    if (message.role === "tool") {
      return Object.freeze({
        role: "tool",
        tool_call_id: message.tool_call_id,
        content: message.content,
      });
    }
    if (message.role === "assistant" && message.tool_calls !== undefined) {
      return Object.freeze({
        role: "assistant",
        content: message.content,
        tool_calls: message.tool_calls.map((call) =>
          Object.freeze({
            id: call.id,
            type: "function",
            function: Object.freeze({ name: call.name, arguments: call.arguments_json }),
          }),
        ),
      });
    }
    return Object.freeze({ role: message.role, content: message.content });
  });
}

function timeoutSignal(timeoutMs: number): Readonly<{ signal: AbortSignal; clear: () => void }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return Object.freeze({ signal: controller.signal, clear: () => clearTimeout(timeout) });
}

async function requestChat(
  fetchPort: FetchPort,
  input: AiProviderChatInput,
): Promise<Readonly<{ response: Response; clear: () => void }>> {
  const timeout = timeoutSignal(input.timeout_ms);
  try {
    const response = await fetchPort(officialUrl(CHAT_PATH), {
      method: "POST",
      signal: timeout.signal,
      headers: { authorization: `Bearer ${input.api_key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        stream: true,
        messages: messageWireShape(input),
        tools: toolWireShape(input),
      }),
    });
    return Object.freeze({ response, clear: timeout.clear });
  } catch (error) {
    timeout.clear();
    throw error;
  }
}

function appendToolDelta(
  calls: Map<number, PartialCall>,
  value: z.output<typeof OpenAiChunkSchema>,
): void {
  const delta = value.choices[0]?.delta;
  for (const item of delta?.tool_calls ?? []) {
    const current = calls.get(item.index) ?? { argumentsJson: "" };
    calls.set(
      item.index,
      Object.freeze({
        ...(item.id === undefined ? current : { ...current, id: item.id }),
        ...(item.function?.name === undefined ? {} : { name: item.function.name }),
        argumentsJson: `${current.argumentsJson}${item.function?.arguments ?? ""}`,
      }),
    );
  }
}

function completeToolCalls(calls: ReadonlyMap<number, PartialCall>): readonly AiToolCall[] {
  const result: AiToolCall[] = [];
  for (const [, call] of [...calls.entries()].sort(([left], [right]) => left - right)) {
    if (call.id === undefined || call.name === undefined) continue;
    result.push(
      Object.freeze({ id: call.id, name: call.name, arguments_json: call.argumentsJson }),
    );
  }
  return Object.freeze(result);
}

async function* parseEventStream(
  response: Response,
  clearTimeout: () => void,
): AsyncGenerator<z.output<typeof AiProviderEventSchema>> {
  if (!response.ok || response.body === null) {
    clearTimeout();
    throw new Error("AI provider request failed");
  }
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const calls = new Map<number, PartialCall>();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseLine(line, calls);
        if (event !== null) yield event;
      }
    }
    const lastEvent = parseLine(buffer, calls);
    if (lastEvent !== null) yield lastEvent;
    const complete = completeToolCalls(calls);
    if (complete.length > 0)
      yield AiProviderEventSchema.parse({ type: "tool_calls", calls: complete });
    yield AiProviderEventSchema.parse({ type: "done" });
  } finally {
    clearTimeout();
    reader.releaseLock();
  }
}

function parseLine(
  line: string,
  calls: Map<number, PartialCall>,
): z.output<typeof AiProviderEventSchema> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return null;
  }
  const chunk = OpenAiChunkSchema.safeParse(decoded);
  if (!chunk.success) return null;
  appendToolDelta(calls, chunk.data);
  const text = chunk.data.choices[0]?.delta.content;
  return text === undefined || text.length === 0
    ? null
    : AiProviderEventSchema.parse({ type: "text_delta", text });
}

async function verifyKey(
  fetchPort: FetchPort,
  apiKey: string,
): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false }>> {
  const timeout = timeoutSignal(10_000);
  try {
    const response = await fetchPort(officialUrl(VERIFY_PATH), {
      method: "GET",
      signal: timeout.signal,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    return Object.freeze({ ok: response.ok });
  } catch {
    return Object.freeze({ ok: false });
  } finally {
    timeout.clear();
  }
}

/** Official OpenAI API adapter; no custom endpoint input exists in M2. */
export function createOpenAiCompatibleProvider(fetchPort: FetchPort = fetch): AiProvider {
  return Object.freeze({
    async *chat(rawInput) {
      const input = AiProviderChatInputSchema.parse(rawInput);
      if (input.provider !== "openai") throw new Error("Unsupported AI provider");
      const request = await requestChat(fetchPort, input);
      yield* parseEventStream(request.response, request.clear);
    },
    async verifyKey(input) {
      if (input.provider !== "openai") return Object.freeze({ ok: false as const });
      return verifyKey(fetchPort, input.api_key);
    },
  });
}

export const OPENAI_OFFICIAL_ORIGIN = OPENAI_API_ORIGIN;
