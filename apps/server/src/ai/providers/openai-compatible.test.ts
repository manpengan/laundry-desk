import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAiCompatibleProvider, OPENAI_OFFICIAL_ORIGIN } from "./openai-compatible.js";

function streamResponse(lines: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

test("OpenAI-compatible adapter only requests the fixed official origin and parses tool deltas", async () => {
  const urls: string[] = [];
  const provider = createOpenAiCompatibleProvider(async (input) => {
    urls.push(String(input));
    return streamResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"stats.day.summary","arguments":"{\\"business_date\\":\\"2026-07-23\\"}"}}]}}]}\n',
      "data: [DONE]\n",
    ]);
  });
  const events = [];
  for await (const event of provider.chat({
    provider: "openai",
    api_key: "sk-test-never-log-1234",
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "read only" },
      { role: "user", content: "today" },
    ],
    tools: [
      {
        name: "stats.day.summary",
        description: "summary",
        input_json_schema: { type: "object" },
      },
    ],
    timeout_ms: 10_000,
  })) {
    events.push(event);
  }

  assert.deepEqual(urls, [`${OPENAI_OFFICIAL_ORIGIN}/v1/chat/completions`]);
  const calls = events.find((event) => event.type === "tool_calls");
  assert.ok(calls);
  assert.deepEqual(calls.calls, [
    { id: "call_1", name: "stats.day.summary", arguments_json: '{"business_date":"2026-07-23"}' },
  ]);
  assert.equal(JSON.stringify({ urls, events }).includes("sk-test-never-log-1234"), false);
});
