import { z } from "zod";

export const SyntheticLookupArgsSchema = z
  .object({ query: z.string().trim().min(1).max(128) })
  .strict();

export type AiProviderMessage = Readonly<{
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: "synthetic.lookup";
  toolArgs?: unknown;
}>;

export type AiProviderEvent =
  | Readonly<{ type: "delta"; text: string }>
  | Readonly<{
      type: "tool_call";
      callId: string;
      name: string;
      args: unknown;
    }>
  | Readonly<{
      type: "end";
      finishReason: "stop" | "tool_calls";
      inputTokens: number;
      outputTokens: number;
    }>
  | Readonly<{
      type: "error";
      code:
        | "provider_auth_rejected"
        | "provider_rate_limited"
        | "provider_unavailable"
        | "provider_timeout"
        | "provider_aborted"
        | "provider_response_invalid"
        | "provider_response_too_large"
        | "provider_network_denied"
        | "provider_failed";
    }>;

export type AiProviderRequest = Readonly<{
  messages: readonly AiProviderMessage[];
  tools: readonly Readonly<{
    name: "synthetic.lookup";
    description: string;
    inputSchema: Readonly<Record<string, unknown>>;
  }>[];
  maxOutputTokens: number;
  signal: AbortSignal;
}>;

/** Provider-neutral port. It deliberately has no URL, headers, credentials, or SDK object. */
export type AiProviderPort = Readonly<{
  kind: "deterministic_fake" | "openai_compatible" | "anthropic" | "gemini";
  stream(request: AiProviderRequest): AsyncIterable<AiProviderEvent>;
}>;

export type FakeProviderStep = Readonly<{
  events: readonly AiProviderEvent[];
  delayMs?: number;
}>;

function abortError(): Error {
  const error = new Error("AI provider stream aborted");
  error.name = "AbortError";
  return error;
}

async function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Explicit deterministic adapter used only by Item 14 focused tests. */
export function createDeterministicFakeProvider(
  steps: readonly FakeProviderStep[],
): AiProviderPort {
  let callIndex = 0;
  return Object.freeze({
    kind: "deterministic_fake" as const,
    async *stream(request: AiProviderRequest): AsyncIterable<AiProviderEvent> {
      const step = steps[Math.min(callIndex, Math.max(steps.length - 1, 0))];
      callIndex += 1;
      if (step === undefined) {
        yield Object.freeze({
          type: "error" as const,
          code: "provider_unavailable" as const,
        });
        return;
      }
      for (const event of step.events) {
        if (request.signal.aborted) throw abortError();
        await waitForDelay(step.delayMs ?? 0, request.signal);
        yield Object.freeze({ ...event }) as AiProviderEvent;
      }
    },
  });
}

export const SYNTHETIC_TOOL_DESCRIPTOR = Object.freeze({
  name: "synthetic.lookup" as const,
  description: "Return deterministic, read-only synthetic test data.",
  inputSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["query"]),
    properties: Object.freeze({
      query: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    }),
  }),
});

export type SyntheticToolPort = Readonly<{
  lookup(input: Readonly<{ query: string }>, signal: AbortSignal): Promise<unknown>;
}>;

export const deterministicSyntheticTool: SyntheticToolPort = Object.freeze({
  async lookup(input, signal) {
    if (signal.aborted) throw abortError();
    return Object.freeze({ found: true, label: `synthetic:${input.query}` });
  },
});
