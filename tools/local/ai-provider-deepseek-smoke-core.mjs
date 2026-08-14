const DEFAULT_TIMEOUT_MS = 15_000;

export const DEEPSEEK_SMOKE_TOOL = Object.freeze({
  name: "synthetic.lookup",
  description: "Return a deterministic smoke-test value.",
  inputSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["query"]),
    properties: Object.freeze({ query: Object.freeze({ type: "string" }) }),
  }),
});

function fail(code) {
  throw new Error(code);
}

function providerError(event) {
  const code = typeof event.code === "string" ? event.code.toUpperCase() : "";
  fail(/^[A-Z0-9_]{1,64}$/u.test(code) ? code : "SMOKE_PROVIDER_ERROR");
}

function validUsage(event) {
  return (
    Number.isSafeInteger(event.inputTokens) &&
    event.inputTokens >= 0 &&
    Number.isSafeInteger(event.outputTokens) &&
    event.outputTokens >= 0
  );
}

function validToolCall(event) {
  if (
    event.name !== "synthetic.lookup" ||
    typeof event.callId !== "string" ||
    event.callId.length < 1 ||
    event.callId.length > 256 ||
    typeof event.args !== "object" ||
    event.args === null ||
    Array.isArray(event.args)
  ) {
    return false;
  }
  const keys = Object.keys(event.args);
  return keys.length === 1 && keys[0] === "query" && event.args.query === "provider-smoke";
}

async function validateTextStream(adapter, timeoutMs) {
  let textEvents = 0;
  let terminal = null;
  for await (const event of adapter.stream({
    messages: Object.freeze([{ role: "user", content: "Reply with the single word READY." }]),
    tools: Object.freeze([]),
    maxOutputTokens: 32,
    signal: AbortSignal.timeout(timeoutMs),
  })) {
    if (terminal !== null) fail("SMOKE_STREAM_AFTER_END");
    if (event?.type === "error") providerError(event);
    if (event?.type === "tool_call") fail("SMOKE_TEXT_TOOL_UNEXPECTED");
    if (event?.type === "delta") {
      if (typeof event.text !== "string" || event.text.length < 1) {
        fail("SMOKE_TEXT_EVENT_INVALID");
      }
      textEvents += 1;
      continue;
    }
    if (event?.type === "end") {
      if (event.finishReason !== "stop" || !validUsage(event)) {
        fail("SMOKE_TEXT_END_INVALID");
      }
      terminal = event;
      continue;
    }
    fail("SMOKE_TEXT_EVENT_INVALID");
  }
  if (textEvents < 1) fail("SMOKE_TEXT_MISSING");
  if (terminal === null) fail("SMOKE_STREAM_INCOMPLETE");
  return Object.freeze({
    textEvents,
    inputTokens: terminal.inputTokens,
    outputTokens: terminal.outputTokens,
  });
}

async function validateToolStream(adapter, timeoutMs) {
  let toolCalls = 0;
  let terminal = null;
  for await (const event of adapter.stream({
    messages: Object.freeze([
      {
        role: "user",
        content:
          'Call the available function once with query "provider-smoke". Do not answer in text.',
      },
    ]),
    tools: Object.freeze([DEEPSEEK_SMOKE_TOOL]),
    maxOutputTokens: 512,
    signal: AbortSignal.timeout(timeoutMs),
  })) {
    if (terminal !== null) fail("SMOKE_STREAM_AFTER_END");
    if (event?.type === "error") providerError(event);
    if (event?.type === "delta") fail("SMOKE_TOOL_TEXT_UNEXPECTED");
    if (event?.type === "tool_call") {
      if (!validToolCall(event)) fail("SMOKE_TOOL_INVALID");
      toolCalls += 1;
      if (toolCalls > 1) fail("SMOKE_TOOL_CALL_COUNT_INVALID");
      continue;
    }
    if (event?.type === "end") {
      if (event.finishReason !== "tool_calls" || !validUsage(event)) {
        fail("SMOKE_TOOL_END_INVALID");
      }
      terminal = event;
      continue;
    }
    fail("SMOKE_TOOL_EVENT_INVALID");
  }
  if (terminal === null) fail("SMOKE_TOOL_STREAM_INCOMPLETE");
  if (toolCalls !== 1) fail("SMOKE_TOOL_CALL_COUNT_INVALID");
  return toolCalls;
}

export async function runDeepSeekProviderSmoke(
  adapter,
  modelId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onPhase = () => undefined,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    fail("SMOKE_TIMEOUT_INVALID");
  }
  onPhase("model_discovery");
  const validation = await adapter.discoverModels(AbortSignal.timeout(timeoutMs));
  if (
    validation?.providerCode !== "deepseek" ||
    !Array.isArray(validation.models) ||
    typeof validation.selectedModelAvailable !== "boolean"
  ) {
    fail("SMOKE_DISCOVERY_INVALID");
  }
  const modelPresent = validation.models.some((model) => model?.modelId === modelId);
  if (!validation.selectedModelAvailable || !modelPresent) fail("SMOKE_MODEL_UNAVAILABLE");
  onPhase("text_stream");
  const text = await validateTextStream(adapter, timeoutMs);
  onPhase("tool_stream");
  const toolCalls = await validateToolStream(adapter, timeoutMs);
  return Object.freeze({
    ok: true,
    provider: "deepseek",
    model: modelId,
    model_discovery: "passed",
    selected_model_available: true,
    stream: "completed",
    text_events: text.textEvents,
    usage: Object.freeze({
      input_tokens: text.inputTokens,
      output_tokens: text.outputTokens,
    }),
    tool_call_validation: "passed",
    tool_calls: toolCalls,
  });
}
