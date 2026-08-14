import assert from "node:assert/strict";
import test from "node:test";

import { runDeepSeekProviderSmoke } from "./ai-provider-deepseek-smoke-core.mjs";

const MODEL = "deepseek-test";
const END_STOP = Object.freeze({
  type: "end",
  finishReason: "stop",
  inputTokens: 7,
  outputTokens: 2,
});
const END_TOOL = Object.freeze({
  type: "end",
  finishReason: "tool_calls",
  inputTokens: 9,
  outputTokens: 4,
});
const TOOL_CALL = Object.freeze({
  type: "tool_call",
  callId: "call-1",
  name: "synthetic.lookup",
  args: Object.freeze({ query: "provider-smoke" }),
});

function fakeAdapter({ selected = true, textEvents, toolEvents } = {}) {
  const requests = [];
  let streamIndex = 0;
  const streams = [
    textEvents ?? [Object.freeze({ type: "delta", text: "READY" }), END_STOP],
    toolEvents ?? [TOOL_CALL, END_TOOL],
  ];
  return {
    requests,
    adapter: Object.freeze({
      providerCode: "deepseek",
      modelId: MODEL,
      discoverModels: async () =>
        Object.freeze({
          providerCode: "deepseek",
          models: Object.freeze([Object.freeze({ modelId: MODEL, displayName: MODEL })]),
          selectedModelAvailable: selected,
        }),
      async *stream(request) {
        requests.push(request);
        for (const event of streams[streamIndex] ?? []) yield event;
        streamIndex += 1;
      },
    }),
  };
}

test("DeepSeek smoke proves model, text, usage, and one exact synthetic tool call", async () => {
  const fixture = fakeAdapter();
  const report = await runDeepSeekProviderSmoke(fixture.adapter, MODEL, 1_000);
  assert.deepEqual(report, {
    ok: true,
    provider: "deepseek",
    model: MODEL,
    model_discovery: "passed",
    selected_model_available: true,
    stream: "completed",
    text_events: 1,
    usage: { input_tokens: 7, output_tokens: 2 },
    tool_call_validation: "passed",
    tool_calls: 1,
  });
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.requests[0].tools.length, 0);
  assert.equal(fixture.requests[1].tools[0].name, "synthetic.lookup");
});

test("DeepSeek smoke stops before streaming when the selected model is unavailable", async () => {
  const fixture = fakeAdapter({ selected: false });
  await assert.rejects(
    () => runDeepSeekProviderSmoke(fixture.adapter, MODEL, 1_000),
    /SMOKE_MODEL_UNAVAILABLE/u,
  );
  assert.equal(fixture.requests.length, 0);
});

test("DeepSeek smoke rejects incomplete text and widened tool behavior", async () => {
  const cases = [
    {
      textEvents: [END_STOP],
      error: /SMOKE_TEXT_MISSING/u,
    },
    {
      textEvents: [Object.freeze({ type: "delta", text: "READY" }), END_STOP],
      toolEvents: [Object.freeze({ type: "delta", text: "calling" }), TOOL_CALL, END_TOOL],
      error: /SMOKE_TOOL_TEXT_UNEXPECTED/u,
    },
    {
      textEvents: [Object.freeze({ type: "delta", text: "READY" }), END_STOP],
      toolEvents: [
        Object.freeze({ ...TOOL_CALL, args: Object.freeze({ query: "other" }) }),
        END_TOOL,
      ],
      error: /SMOKE_TOOL_INVALID/u,
    },
    {
      textEvents: [Object.freeze({ type: "delta", text: "READY" }), END_STOP],
      toolEvents: [TOOL_CALL, TOOL_CALL, END_TOOL],
      error: /SMOKE_TOOL_CALL_COUNT_INVALID/u,
    },
  ];
  for (const fixture of cases) {
    const provider = fakeAdapter(fixture);
    await assert.rejects(
      () => runDeepSeekProviderSmoke(provider.adapter, MODEL, 1_000),
      fixture.error,
    );
  }
});
