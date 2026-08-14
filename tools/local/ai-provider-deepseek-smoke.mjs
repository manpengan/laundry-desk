import { createProviderAdapter } from "../../apps/server/dist/ai/provider-registry.js";
import { runDeepSeekProviderSmoke } from "./ai-provider-deepseek-smoke-core.mjs";
import { readPrivateCredential } from "./ai-provider-smoke-secret.mjs";

const SAFE_MODEL = /^[^\p{Cc}\p{Zl}\p{Zp}]{1,128}$/u;
let smokePhase = "startup";

async function main() {
  const credentialFile = process.env.DEEPSEEK_API_KEY_FILE;
  const modelId = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro";
  if (!SAFE_MODEL.test(modelId)) throw new Error("SMOKE_MODEL_INVALID");
  const authority = Object.freeze({
    async run(operation) {
      const secret = readPrivateCredential(credentialFile);
      try {
        return await operation(secret);
      } finally {
        secret.fill(0);
      }
    },
    async *stream(operation) {
      const secret = readPrivateCredential(credentialFile);
      try {
        yield* operation(secret);
      } finally {
        secret.fill(0);
      }
    },
  });
  const adapter = createProviderAdapter({
    providerCode: "deepseek",
    modelId,
    credentialAuthority: authority,
  });
  console.log(
    JSON.stringify(
      await runDeepSeekProviderSmoke(adapter, modelId, 15_000, (phase) => {
        smokePhase = phase;
      }),
    ),
  );
}

main().catch((error) => {
  const code =
    error instanceof Error && /^[A-Z0-9_]{1,64}$/u.test(error.message)
      ? error.message
      : "SMOKE_FAILED";
  console.error(JSON.stringify({ ok: false, phase: smokePhase, code }));
  process.exitCode = 1;
});
