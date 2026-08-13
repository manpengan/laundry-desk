import {
  createEphemeralCredentialAuthority,
  createProviderAdapter,
} from "../../apps/server/dist/ai/index.js";
import { readPrivateCredential } from "./ai-provider-smoke-secret.mjs";

const SAFE_MODEL = /^[^\p{Cc}\p{Zl}\p{Zp}]{1,128}$/u;

const SYNTHETIC_TOOL = Object.freeze({
  name: "synthetic.lookup",
  description: "Return a deterministic smoke-test value.",
  inputSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["query"]),
    properties: Object.freeze({ query: Object.freeze({ type: "string" }) }),
  }),
});

async function main() {
  const credentialFile = process.env.DEEPSEEK_API_KEY_FILE;
  const modelId = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro";
  if (!SAFE_MODEL.test(modelId)) throw new Error("SMOKE_MODEL_INVALID");
  const authority = createEphemeralCredentialAuthority(async () =>
    readPrivateCredential(credentialFile),
  );
  const adapter = createProviderAdapter({
    providerCode: "deepseek",
    modelId,
    credentialAuthority: authority,
  });
  const validation = await adapter.discoverModels(AbortSignal.timeout(15_000));
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let completed = false;
  for await (const event of adapter.stream({
    messages: Object.freeze([{ role: "user", content: "Reply with the single word READY." }]),
    tools: Object.freeze([]),
    maxOutputTokens: 32,
    signal: AbortSignal.timeout(15_000),
  })) {
    if (event.type === "tool_call") toolCalls += 1;
    if (event.type === "error") throw new Error(event.code.toUpperCase());
    if (event.type === "end") {
      inputTokens = event.inputTokens;
      outputTokens = event.outputTokens;
      completed = true;
    }
  }
  if (!completed) throw new Error("SMOKE_STREAM_INCOMPLETE");
  let toolCompleted = false;
  for await (const event of adapter.stream({
    messages: Object.freeze([
      {
        role: "user",
        content:
          'Call the available function once with query "provider-smoke". Do not answer in text.',
      },
    ]),
    tools: Object.freeze([SYNTHETIC_TOOL]),
    maxOutputTokens: 64,
    signal: AbortSignal.timeout(15_000),
  })) {
    if (event.type === "tool_call") {
      if (event.name !== "synthetic.lookup") throw new Error("SMOKE_TOOL_INVALID");
      toolCalls += 1;
    }
    if (event.type === "error") throw new Error(event.code.toUpperCase());
    if (event.type === "end") toolCompleted = event.finishReason === "tool_calls";
  }
  if (!toolCompleted || toolCalls !== 1) throw new Error("SMOKE_TOOL_CALL_MISSING");
  console.log(
    JSON.stringify({
      ok: true,
      provider: "deepseek",
      model: modelId,
      model_discovery: "passed",
      selected_model_available: validation.selectedModelAvailable,
      stream: "completed",
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      tool_call_validation: "passed",
      tool_calls: toolCalls,
    }),
  );
}

main().catch((error) => {
  const code =
    error instanceof Error && /^[A-Z0-9_]{1,64}$/u.test(error.message)
      ? error.message
      : "SMOKE_FAILED";
  console.error(JSON.stringify({ ok: false, code }));
  process.exitCode = 1;
});
