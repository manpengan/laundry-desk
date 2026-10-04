import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AiRuntimeConfig } from "@laundry/contracts";
import type { PgPool } from "../db/pg-pool.js";
import type { SqlClient } from "../db/types.js";
import { createMemoryLocalRuntime } from "../local/demo-seed.js";
import { createByokRuntime, type ByokRuntime } from "./byok-runtime.js";
import { MemoryByokStore } from "./byok-memory-store.js";
import { TestByokKms } from "./byok-test-kms.js";
import { encryptCredential } from "./byok-envelope.js";
import { createRuntimeVisionProviderResolver } from "./vision-runtime-provider.js";
const context = {
  tenant: { orgId: randomUUID(), storeId: randomUUID(), staffId: randomUUID() },
  authSessionId: randomUUID(),
  deviceId: randomUUID(),
  permissions: ["ai_use"],
};
async function fixture(provider_code: "deepseek" | "anthropic" | "gemini", model_id: string) {
  const local = await createMemoryLocalRuntime();
  const store = new MemoryByokStore();
  const kms = new TestByokKms();
  let config: AiRuntimeConfig = {
    version: 1,
    enabled: true,
    provider_code,
    model_id,
    monthly_limit_micros: 1000000,
    input_micros_per_million: 1000000,
    output_micros_per_million: 1000000,
  };
  const client: SqlClient = {
    async query<T>() {
      return { rows: [{ config }] as T[], rowCount: 1 };
    },
  };
  const base = createByokRuntime(local, kms, store);
  const runtime: ByokRuntime = {
    ...base,
    local: { ...local, pool: {} as PgPool },
    async transact(tenant, operation) {
      return operation({ tenant, client });
    },
  };
  const id = randomUUID();
  const at = new Date();
  const transaction = { client, tenant: context.tenant };
  const envelope = await encryptCredential(
    kms,
    { orgId: context.tenant.orgId, providerCode: provider_code, credentialId: id },
    Buffer.from("fixture-vision-key-1234"),
  );
  await store.stageCredential(
    {
      id,
      orgId: context.tenant.orgId,
      providerCode: provider_code,
      credentialVersion: 1,
      rowVersion: 1,
      status: "pending_verification",
      envelope,
      last4: "1234",
      createdByStaffId: context.tenant.staffId,
      createdAt: at,
      updatedByStaffId: context.tenant.staffId,
      updatedAt: at,
      activatedAt: null,
      revokedAt: null,
      supersededAt: null,
    },
    transaction,
  );
  await store.activateCredential(id, context.tenant.staffId, at, transaction);
  return {
    runtime,
    setVersion: () => {
      config = { ...config, version: config.version + 1 };
    },
  };
}
test("vision refuses DeepSeek and unregistered Gemini models before egress", async () => {
  for (const code of ["deepseek", "gemini"] as const) {
    const f = await fixture(code, "unverified-model");
    let calls = 0;
    const resolver = createRuntimeVisionProviderResolver(f.runtime, {
      async request() {
        calls++;
        throw new Error("must not call");
      },
    });
    await assert.rejects(resolver(context, new AbortController().signal), /VISION_UNAVAILABLE/u);
    assert.equal(calls, 0);
  }
});
test("Anthropic image capability must be affirmative; config replacement invalidates an approved provider", async () => {
  const f = await fixture("anthropic", "fixture-vision-model");
  let supported = false;
  let calls = 0;
  const resolver = createRuntimeVisionProviderResolver(f.runtime, {
    async request(input) {
      calls++;
      assert.equal(input.url, "https://api.anthropic.com/v1/models/fixture-vision-model");
      return {
        status: 200,
        contentType: "application/json",
        body: (async function* () {
          yield Buffer.from(
            JSON.stringify({ type: "model", capabilities: { image_input: { supported } } }),
          );
        })(),
      };
    },
  });
  await assert.rejects(resolver(context, new AbortController().signal));
  supported = true;
  const provider = await resolver(context, new AbortController().signal);
  f.setVersion();
  await assert.rejects(async () => {
    for await (const event of provider.stream({
      messages: [{ role: "user", content: "test" }],
      tools: [],
      maxOutputTokens: 32,
      signal: new AbortController().signal,
    }))
      void event;
  }, /VISION_UNAVAILABLE/u);
  assert.equal(calls, 2);
});
