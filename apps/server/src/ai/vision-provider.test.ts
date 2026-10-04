import assert from "node:assert/strict";
import test from "node:test";
import { createProviderAdapter } from "./provider-registry.js";
import { createEphemeralCredentialAuthority } from "./provider-credential-authority.js";
import type { ProviderHttpRequest } from "./provider-http.js";
import type { AiProviderEvent } from "./streaming-provider.js";
const image = {
  mediaType: "image/jpeg" as const,
  data: Buffer.from("fixture image bytes").toString("base64"),
};
for (const code of ["anthropic", "gemini"] as const)
  test(`${code} uses fixed inline image shape, excludes tools and counts thinking tokens`, async () => {
    let request: ProviderHttpRequest | undefined;
    const frames =
      code === "anthropic"
        ? [
            { type: "message_start", message: { usage: { input_tokens: 100 } } },
            { type: "content_block_delta", delta: { type: "text_delta", text: "{}" } },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 5 },
            },
            { type: "message_stop" },
          ]
        : [
            {
              candidates: [
                {
                  content: { parts: [{ text: "PRIVATE_THOUGHT", thought: true }, { text: "{}" }] },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 2,
                thoughtsTokenCount: 3,
              },
            },
          ];
    const adapter = createProviderAdapter({
      providerCode: code,
      modelId: "fixture-model",
      credentialAuthority: createEphemeralCredentialAuthority(async () =>
        Buffer.from("fixture-key-not-real"),
      ),
      http: {
        async request(input) {
          request = input;
          return {
            status: 200,
            contentType: "text/event-stream",
            body: (async function* () {
              yield Buffer.from(
                frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
              );
            })(),
          };
        },
      },
    });
    const events: AiProviderEvent[] = [];
    for await (const event of adapter.stream({
      messages: [{ role: "user", content: "classify", images: [image] }],
      tools: [],
      maxOutputTokens: 10,
      signal: new AbortController().signal,
    }))
      events.push(event);
    assert.ok(request?.body);
    assert.match(request.body, code === "anthropic" ? /"type":"image"/u : /"inlineData"/u);
    assert.equal(JSON.stringify(events).includes("PRIVATE_THOUGHT"), false);
    assert.deepEqual(events.at(-1), {
      type: "end",
      finishReason: "stop",
      inputTokens: 100,
      outputTokens: 5,
    });
  });
test("DeepSeek refuses photos before network and assistant/tool images are invalid", async () => {
  for (const providerCode of ["deepseek", "anthropic", "gemini"] as const) {
    let calls = 0;
    const adapter = createProviderAdapter({
      providerCode,
      modelId: "fixture-model",
      credentialAuthority: createEphemeralCredentialAuthority(async () =>
        Buffer.from("fixture-key-not-real"),
      ),
      http: {
        async request() {
          calls++;
          throw new Error("must not dispatch");
        },
      },
    });
    const events = [];
    for await (const event of adapter.stream({
      messages: [{ role: "assistant", content: "image", images: [image] }],
      tools: [],
      maxOutputTokens: 10,
      signal: new AbortController().signal,
    }))
      events.push(event);
    assert.equal(calls, 0);
    assert.equal(events[0]?.type, "error");
  }
});

for (const providerCode of ["anthropic", "gemini"] as const)
  test(`${providerCode} reports truncated usage and never releases a partial tool call`, async () => {
    const frames =
      providerCode === "anthropic"
        ? [
            { type: "message_start", message: { usage: { input_tokens: 100 } } },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "fixture", name: "arbitrary" },
            },
            {
              type: "message_delta",
              delta: { stop_reason: "max_tokens" },
              usage: { output_tokens: 512 },
            },
            { type: "message_stop" },
          ]
        : [
            {
              candidates: [
                {
                  content: { parts: [{ functionCall: { name: "arbitrary", args: {} } }] },
                  finishReason: "MAX_TOKENS",
                },
              ],
              usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 12,
                thoughtsTokenCount: 500,
              },
            },
          ];
    const adapter = createProviderAdapter({
      providerCode,
      modelId: "fixture-model",
      credentialAuthority: createEphemeralCredentialAuthority(async () =>
        Buffer.from("fixture-key-not-real"),
      ),
      http: {
        async request() {
          return {
            status: 200,
            contentType: "text/event-stream",
            body: (async function* () {
              yield Buffer.from(
                frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
              );
            })(),
          };
        },
      },
    });
    const events: AiProviderEvent[] = [];
    for await (const event of adapter.stream({
      messages: [{ role: "user", content: "classify" }],
      tools: [],
      maxOutputTokens: 512,
      signal: new AbortController().signal,
    }))
      events.push(event);
    assert.deepEqual(events, [
      { type: "end", finishReason: "limit", inputTokens: 100, outputTokens: 512 },
    ]);
  });
