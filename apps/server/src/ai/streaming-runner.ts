import { createHash, randomUUID } from "node:crypto";

import type { AiStreamEvent } from "@laundry/contracts";

import {
  SYNTHETIC_TOOL_DESCRIPTOR,
  SyntheticLookupArgsSchema,
  type AiProviderMessage,
  type AiProviderPort,
  type SyntheticToolPort,
} from "./streaming-provider.js";
import type {
  AiConversationStore,
  AiEventDraft,
  AiRequestContext,
  AiTurnRecord,
} from "./streaming-store.js";

export const AI_STREAM_LIMITS = Object.freeze({
  maxToolSteps: 4,
  toolTimeoutMs: 1_000,
  totalDeadlineMs: 15_000,
  maxInputTokens: 20_000,
  maxOutputBytes: 32_768,
  maxOutputChars: 8_000,
  maxOutputTokens: 1_024,
  maxEvents: 256,
});

type RuntimeState = {
  assistantText: string;
  outputBytes: number;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  toolSteps: number;
  finishReason: "stop" | "limit";
};

type SafeErrorCode = Extract<AiStreamEvent, { type: "error" }>["code"];

export const sha256Text = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function linkedAbort(parent: AbortSignal): Readonly<{
  signal: AbortSignal;
  dispose: () => void;
}> {
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(AI_STREAM_LIMITS.totalDeadlineMs);
  const parentAbort = () => controller.abort("AI_ABORTED");
  const deadlineAbort = () => controller.abort("AI_DEADLINE_EXCEEDED");
  parent.addEventListener("abort", parentAbort, { once: true });
  deadline.addEventListener("abort", deadlineAbort, { once: true });
  if (parent.aborted) parentAbort();
  else if (deadline.aborted) deadlineAbort();
  return Object.freeze({
    signal: controller.signal,
    dispose: () => {
      parent.removeEventListener("abort", parentAbort);
      deadline.removeEventListener("abort", deadlineAbort);
    },
  });
}

async function persistEvent(
  store: AiConversationStore,
  turnId: string,
  context: AiRequestContext,
  event: AiEventDraft,
  onEvent: (event: AiStreamEvent) => Promise<void>,
): Promise<AiStreamEvent> {
  const persisted = await store.appendEvent({
    id: randomUUID(),
    turnId,
    event,
    context,
    now: new Date(),
  });
  await onEvent(persisted);
  return persisted;
}

function accountForEvent(state: RuntimeState, event: AiStreamEvent): void {
  state.eventCount += 1;
  if (event.type !== "content_delta") return;
  state.outputBytes += Buffer.byteLength(event.text, "utf8");
  state.assistantText += event.text;
}

async function executeTool(
  store: AiConversationStore,
  tool: SyntheticToolPort,
  turn: AiTurnRecord,
  context: AiRequestContext,
  step: number,
  args: unknown,
  parentSignal: AbortSignal,
): Promise<
  Readonly<{
    message: AiProviderMessage;
    outcome: "succeeded" | "failed" | "timed_out" | "cancelled";
  }>
> {
  const parsed = SyntheticLookupArgsSchema.safeParse(args);
  const startedAt = Date.now();
  const requestHash = sha256Text(JSON.stringify(parsed.success ? parsed.data : { invalid: true }));
  const timeoutSignal = AbortSignal.timeout(AI_STREAM_LIMITS.toolTimeoutMs);
  const signal = AbortSignal.any([parentSignal, timeoutSignal]);
  let result: unknown = Object.freeze({ error: "invalid_tool_input" });
  let outcome: "succeeded" | "failed" | "timed_out" | "cancelled" = "failed";
  try {
    if (!parsed.success) throw new Error("invalid tool input");
    result = await tool.lookup(parsed.data, signal);
    outcome = "succeeded";
  } catch {
    outcome = parentSignal.aborted ? "cancelled" : timeoutSignal.aborted ? "timed_out" : "failed";
    result = Object.freeze({ error: outcome });
  }
  const serialized = JSON.stringify(result);
  await store.appendToolAttempt({
    attempt: Object.freeze({
      id: randomUUID(),
      turnId: turn.id,
      step,
      requestSha256: requestHash,
      resultSha256: sha256Text(serialized),
      outcome,
      durationMs: Math.min(AI_STREAM_LIMITS.toolTimeoutMs, Date.now() - startedAt),
      createdAt: new Date(),
    }),
    context,
  });
  return Object.freeze({
    message: Object.freeze({ role: "tool" as const, content: serialized }),
    outcome,
  });
}

async function finishTurn(
  store: AiConversationStore,
  turn: AiTurnRecord,
  context: AiRequestContext,
  state: RuntimeState,
  status: "completed" | "failed" | "cancelled",
  errorCode: SafeErrorCode | null,
): Promise<void> {
  await store.finishTurn({
    turnId: turn.id,
    context,
    finish: Object.freeze({
      status,
      errorCode,
      assistantMessageId: randomUUID(),
      assistantText: state.assistantText,
      assistantSha256: sha256Text(state.assistantText),
      usage: Object.freeze({
        id: randomUUID(),
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        outputBytes: state.outputBytes,
        eventCount: state.eventCount,
        toolSteps: state.toolSteps,
      }),
      auditId: randomUUID(),
      completedAt: new Date(),
    }),
  });
}

function safeErrorCode(error: unknown, signal: AbortSignal): SafeErrorCode {
  const rawCode = error instanceof Error ? error.message : "AI_PROVIDER_FAILED";
  if (signal.aborted && rawCode !== "AI_TOOL_TIMEOUT") {
    return signal.reason === "AI_DEADLINE_EXCEEDED" ? "AI_DEADLINE_EXCEEDED" : "AI_ABORTED";
  }
  if (
    rawCode === "AI_OUTPUT_LIMIT" ||
    rawCode === "AI_TOOL_LIMIT" ||
    rawCode === "AI_TOOL_TIMEOUT" ||
    rawCode === "AI_ABORTED"
  ) {
    return rawCode;
  }
  return "AI_PROVIDER_FAILED";
}

async function runLoop(
  store: AiConversationStore,
  provider: AiProviderPort,
  tool: SyntheticToolPort,
  turn: AiTurnRecord,
  messages: readonly AiProviderMessage[],
  context: AiRequestContext,
  signal: AbortSignal,
  onEvent: (event: AiStreamEvent) => Promise<void>,
): Promise<void> {
  const state: RuntimeState = {
    assistantText: "",
    outputBytes: 0,
    eventCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolSteps: 0,
    finishReason: "stop",
  };
  let activeMessages = [...messages];
  try {
    while (!signal.aborted) {
      let continueWithTool = false;
      for await (const providerEvent of provider.stream({
        messages: Object.freeze(activeMessages),
        tools: Object.freeze([SYNTHETIC_TOOL_DESCRIPTOR]),
        maxOutputTokens: turn.maxOutputTokens,
        signal,
      })) {
        if (providerEvent.type === "delta") {
          const nextBytes = state.outputBytes + Buffer.byteLength(providerEvent.text, "utf8");
          const nextChars = state.assistantText.length + providerEvent.text.length;
          if (nextBytes > AI_STREAM_LIMITS.maxOutputBytes) throw new Error("AI_OUTPUT_LIMIT");
          if (nextChars > AI_STREAM_LIMITS.maxOutputChars) throw new Error("AI_OUTPUT_LIMIT");
          if (state.eventCount + 1 >= AI_STREAM_LIMITS.maxEvents)
            throw new Error("AI_OUTPUT_LIMIT");
          accountForEvent(
            state,
            await persistEvent(
              store,
              turn.id,
              context,
              { type: "content_delta", text: providerEvent.text },
              onEvent,
            ),
          );
          continue;
        }
        if (providerEvent.type === "error") throw new Error("AI_PROVIDER_FAILED");
        if (providerEvent.type === "end") {
          const nextInputTokens = state.inputTokens + providerEvent.inputTokens;
          const nextOutputTokens = state.outputTokens + providerEvent.outputTokens;
          if (nextInputTokens > AI_STREAM_LIMITS.maxInputTokens) throw new Error("AI_OUTPUT_LIMIT");
          if (
            nextOutputTokens > turn.maxOutputTokens ||
            nextOutputTokens > AI_STREAM_LIMITS.maxOutputTokens
          ) {
            throw new Error("AI_OUTPUT_LIMIT");
          }
          state.inputTokens = nextInputTokens;
          state.outputTokens = nextOutputTokens;
          continueWithTool = providerEvent.finishReason === "tool_calls";
          continue;
        }
        state.toolSteps += 1;
        if (state.toolSteps > AI_STREAM_LIMITS.maxToolSteps) throw new Error("AI_TOOL_LIMIT");
        if (state.eventCount + 3 > AI_STREAM_LIMITS.maxEvents) throw new Error("AI_OUTPUT_LIMIT");
        if (providerEvent.name !== "synthetic.lookup") throw new Error("AI_PROVIDER_FAILED");
        accountForEvent(
          state,
          await persistEvent(
            store,
            turn.id,
            context,
            { type: "tool_call", tool: "synthetic.lookup", step: state.toolSteps },
            onEvent,
          ),
        );
        const toolResult = await executeTool(
          store,
          tool,
          turn,
          context,
          state.toolSteps,
          providerEvent.args,
          signal,
        );
        accountForEvent(
          state,
          await persistEvent(
            store,
            turn.id,
            context,
            {
              type: "tool_result",
              tool: "synthetic.lookup",
              step: state.toolSteps,
              outcome: toolResult.outcome,
            },
            onEvent,
          ),
        );
        if (toolResult.outcome === "timed_out") throw new Error("AI_TOOL_TIMEOUT");
        if (toolResult.outcome === "cancelled") throw new Error("AI_ABORTED");
        activeMessages = [
          ...activeMessages,
          Object.freeze({
            role: "assistant" as const,
            content: "",
            toolCallId: providerEvent.callId,
          }),
          Object.freeze({ ...toolResult.message, toolCallId: providerEvent.callId }),
        ];
        continueWithTool = true;
      }
      if (continueWithTool) continue;
      accountForEvent(
        state,
        await persistEvent(
          store,
          turn.id,
          context,
          {
            type: "done",
            finish_reason: state.finishReason,
            input_tokens: state.inputTokens,
            output_tokens: Math.min(state.outputTokens, turn.maxOutputTokens),
          },
          onEvent,
        ),
      );
      await finishTurn(store, turn, context, state, "completed", null);
      return;
    }
    throw new Error("AI_ABORTED");
  } catch (error) {
    const errorCode = safeErrorCode(error, signal);
    try {
      accountForEvent(
        state,
        await persistEvent(store, turn.id, context, { type: "error", code: errorCode }, onEvent),
      );
    } catch {
      // The event is durable even if the disconnected client rejects delivery.
    }
    await finishTurn(
      store,
      turn,
      context,
      state,
      errorCode === "AI_ABORTED" ? "cancelled" : "failed",
      errorCode,
    );
  }
}

export async function runAiTurn(
  input: Readonly<{
    store: AiConversationStore;
    provider: AiProviderPort;
    tool: SyntheticToolPort;
    turn: AiTurnRecord;
    messages: readonly AiProviderMessage[];
    context: AiRequestContext;
    parentSignal: AbortSignal;
    onEvent: (event: AiStreamEvent) => Promise<void>;
  }>,
): Promise<void> {
  const linked = linkedAbort(input.parentSignal);
  try {
    await runLoop(
      input.store,
      input.provider,
      input.tool,
      input.turn,
      input.messages,
      input.context,
      linked.signal,
      input.onEvent,
    );
  } finally {
    linked.dispose();
  }
}
