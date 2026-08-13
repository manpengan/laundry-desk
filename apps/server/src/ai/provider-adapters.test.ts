import assert from "node:assert/strict";
import test from "node:test";

import { createEphemeralCredentialAuthority } from "./provider-credential-authority.js";
import type {
  ProviderHttpPort,
  ProviderHttpRequest,
  ProviderHttpResponse,
} from "./provider-http.js";
import { createProviderAdapter } from "./provider-registry.js";
import { ProviderAdapterError, type ProviderAdapter, type ProviderCode } from "./provider-types.js";
import type { AiProviderEvent, AiProviderRequest } from "./streaming-provider.js";

const SECRET = "fixture-provider-credential-1234";

async function* chunks(value: string | Uint8Array): AsyncIterable<Uint8Array> {
  yield typeof value === "string" ? Buffer.from(value) : value;
}

function response(status: number, body: string | Uint8Array): ProviderHttpResponse {
  return Object.freeze({ status, contentType: "application/json", body: chunks(body) });
}

function sse(...values: readonly unknown[]): ProviderHttpResponse {
  const frames = values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
  return Object.freeze({
    status: 200,
    contentType: "text/event-stream",
    body: chunks(`${frames}data: [DONE]\n\n`),
  });
}

class QueueHttp implements ProviderHttpPort {
  readonly requests: ProviderHttpRequest[] = [];

  constructor(private readonly responses: readonly (ProviderHttpResponse | Error)[]) {}

  async request(input: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(input);
    const result = this.responses[this.requests.length - 1];
    if (result === undefined) throw new Error("missing fixture response");
    if (result instanceof Error) throw result;
    return result;
  }
}

function authority() {
  return createEphemeralCredentialAuthority(async () => Buffer.from(SECRET, "ascii"));
}

function adapter(providerCode: ProviderCode, modelId: string, http: ProviderHttpPort) {
  return createProviderAdapter({ providerCode, modelId, credentialAuthority: authority(), http });
}

const REQUEST: AiProviderRequest = Object.freeze({
  messages: Object.freeze([{ role: "user" as const, content: "hello" }]),
  tools: Object.freeze([
    Object.freeze({
      name: "synthetic.lookup" as const,
      description: "Lookup fixture",
      inputSchema: Object.freeze({ type: "object", required: Object.freeze(["query"]) }),
    }),
  ]),
  maxOutputTokens: 64,
  signal: new AbortController().signal,
});

async function collect(provider: ProviderAdapter): Promise<readonly AiProviderEvent[]> {
  const values: AiProviderEvent[] = [];
  for await (const event of provider.stream(REQUEST)) values.push(event);
  return values;
}

test("DeepSeek uses the fixed OpenAI-compatible models and streaming shapes", async () => {
  const http = new QueueHttp([
    response(
      200,
      JSON.stringify({
        object: "list",
        data: [{ id: "deepseek-v4-pro", object: "model", created: 1, owned_by: "deepseek" }],
      }),
    ),
    sse(
      { choices: [{ delta: { content: "READY" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 1 } },
    ),
  ]);
  const provider = adapter("deepseek", "deepseek-v4-pro", http);
  const discovery = await provider.discoverModels(REQUEST.signal);
  assert.equal(discovery.selectedModelAvailable, true);
  assert.deepEqual(await collect(provider), [
    { type: "delta", text: "READY" },
    { type: "end", finishReason: "stop", inputTokens: 7, outputTokens: 1 },
  ]);
  assert.equal(http.requests[0]?.url, "https://api.deepseek.com/v1/models");
  assert.equal(http.requests[1]?.url, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(http.requests[1]?.headers.authorization, `Bearer ${SECRET}`);
  assert.deepEqual(JSON.parse(http.requests[1]?.body ?? ""), {
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        function: {
          name: "synthetic_lookup",
          description: "Lookup fixture",
          parameters: { type: "object", required: ["query"] },
        },
      },
    ],
    tool_choice: "auto",
    max_tokens: 64,
    stream: true,
    stream_options: { include_usage: true },
  });
});

test("Anthropic uses x-api-key, versioned Messages, and official SSE events", async () => {
  const http = new QueueHttp([
    response(
      200,
      JSON.stringify({ data: [{ id: "claude-test", type: "model", display_name: "Claude Test" }] }),
    ),
    sse(
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "READY" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ),
  ]);
  const provider = adapter("anthropic", "claude-test", http);
  assert.equal((await provider.discoverModels(REQUEST.signal)).selectedModelAvailable, true);
  assert.deepEqual(await collect(provider), [
    { type: "delta", text: "READY" },
    { type: "end", finishReason: "stop", inputTokens: 5, outputTokens: 1 },
  ]);
  assert.equal(http.requests[0]?.url, "https://api.anthropic.com/v1/models?limit=200");
  assert.equal(http.requests[1]?.url, "https://api.anthropic.com/v1/messages");
  assert.equal(http.requests[1]?.headers["x-api-key"], SECRET);
  assert.equal(http.requests[1]?.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(JSON.parse(http.requests[1]?.body ?? ""), {
    model: "claude-test",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        name: "synthetic_lookup",
        description: "Lookup fixture",
        input_schema: {
          type: "object",
          required: ["query"],
        },
      },
    ],
    stream: true,
  });
});

test("Gemini uses x-goog-api-key, model discovery, and SSE generateContent", async () => {
  const http = new QueueHttp([
    response(
      200,
      JSON.stringify({ models: [{ name: "models/gemini-test", displayName: "Gemini Test" }] }),
    ),
    sse({
      candidates: [{ content: { parts: [{ text: "READY" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 },
    }),
  ]);
  const provider = adapter("gemini", "gemini-test", http);
  assert.equal((await provider.discoverModels(REQUEST.signal)).selectedModelAvailable, true);
  assert.deepEqual(await collect(provider), [
    { type: "delta", text: "READY" },
    { type: "end", finishReason: "stop", inputTokens: 4, outputTokens: 1 },
  ]);
  assert.equal(
    http.requests[0]?.url,
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
  );
  assert.equal(
    http.requests[1]?.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
  );
  assert.equal(http.requests[1]?.headers["x-goog-api-key"], SECRET);
  assert.deepEqual(JSON.parse(http.requests[1]?.body ?? ""), {
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    tools: [
      {
        functionDeclarations: [
          {
            name: "synthetic_lookup",
            description: "Lookup fixture",
            parameters: {
              type: "object",
              required: ["query"],
            },
          },
        ],
      },
    ],
    generationConfig: { maxOutputTokens: 64 },
  });
});

test("all adapters normalize tool calls and usage into the typed provider port", async () => {
  const fixtures: readonly [ProviderCode, string, ProviderHttpResponse][] = [
    [
      "deepseek",
      "deepseek-v4-pro",
      sse(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-d",
                    function: { name: "synthetic_lookup", arguments: '{"query":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"d"}' } }] },
              finish_reason: "tool_calls",
            },
          ],
        },
        { choices: [], usage: { prompt_tokens: 8, completion_tokens: 3 } },
      ),
    ],
    [
      "anthropic",
      "claude-test",
      sse(
        { type: "message_start", message: { usage: { input_tokens: 8 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "call-a", name: "synthetic_lookup", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"query":"a"}' },
        },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ),
    ],
    [
      "gemini",
      "gemini-test",
      sse({
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { id: "call-g", name: "synthetic_lookup", args: { query: "g" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 },
      }),
    ],
  ];
  for (const [providerCode, modelId, fixture] of fixtures) {
    const events = await collect(adapter(providerCode, modelId, new QueueHttp([fixture])));
    assert.equal(events[0]?.type, "tool_call", providerCode);
    assert.deepEqual(events[1], {
      type: "end",
      finishReason: "tool_calls",
      inputTokens: 8,
      outputTokens: 3,
    });
  }
});

test("provider failures are bounded and never expose credentials or raw responses", async () => {
  const cases: readonly [ProviderHttpResponse | Error, string][] = [
    [response(401, "denied"), "provider_auth_rejected"],
    [response(403, "denied"), "provider_auth_rejected"],
    [response(429, "limited"), "provider_rate_limited"],
    [response(503, "down"), "provider_unavailable"],
    [new ProviderAdapterError("PROVIDER_TIMEOUT"), "provider_timeout"],
    [new ProviderAdapterError("PROVIDER_ABORTED"), "provider_aborted"],
    [response(200, "data: not-json\n\n"), "provider_response_invalid"],
    [response(200, new Uint8Array(1_048_577)), "provider_response_too_large"],
  ];
  for (const [fixture, code] of cases) {
    const events = await collect(adapter("deepseek", "deepseek-v4-pro", new QueueHttp([fixture])));
    assert.deepEqual(events, [{ type: "error", code }]);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(SECRET, "u"));
  }
});

test("credential authority zeroes each lease on success and failure", async () => {
  let leased: Buffer | null = null;
  const credentialAuthority = createEphemeralCredentialAuthority(async () => Buffer.from(SECRET));
  await credentialAuthority.run(async (credential) => {
    leased = credential;
  });
  assert.ok(leased);
  assert.equal(
    (leased as Buffer).every((byte) => byte === 0),
    true,
  );
  await assert.rejects(() =>
    credentialAuthority.run(async (credential) => {
      leased = credential;
      throw new Error("fixture failure");
    }),
  );
  assert.equal(
    (leased as Buffer).every((byte) => byte === 0),
    true,
  );
});
