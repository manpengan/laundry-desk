import assert from "node:assert/strict";
import { test } from "node:test";
import type { AiRuntimeConfig } from "@laundry/contracts";
import { createMemoryLocalRuntime } from "../local/demo-seed.js";
import type { PgPool } from "../db/pg-pool.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { createByokRuntime, type ByokRuntime } from "./byok-runtime.js";
import { MemoryByokStore } from "./byok-memory-store.js";
import { TestByokKms } from "./byok-test-kms.js";
import { encryptCredential } from "./byok-envelope.js";
import { createRuntimeProviderResolver } from "./runtime-provider.js";
import { createAiStreamingService } from "./streaming-service.js";
import { MemoryAiConversationStore } from "./streaming-memory-store.js";
import { deterministicSyntheticTool } from "./streaming-provider.js";
import type { AiRequestContext } from "./streaming-store.js";

const context: AiRequestContext = {
  tenant: {
    orgId: "11111111-1111-4111-8111-111111111111",
    storeId: "22222222-2222-4222-8222-222222222222",
    staffId: "33333333-3333-4333-8333-333333333333",
  },
  authSessionId: "44444444-4444-4444-8444-444444444444",
  deviceId: "55555555-5555-4555-8555-555555555555",
  permissions: ["ai_use"],
};
const credentialId = "66666666-6666-4666-8666-666666666666";
const settings: AiRuntimeConfig = {
  version: 1,
  enabled: true,
  provider_code: "deepseek",
  model_id: "fixture-model",
  monthly_limit_micros: 1_000_000,
  input_micros_per_million: 1_000_000,
  output_micros_per_million: 1_000_000,
};
async function fixture() {
  const local = await createMemoryLocalRuntime();
  const store = new MemoryByokStore();
  const kms = new TestByokKms();
  let config: AiRuntimeConfig | null = settings;
  const tenants: TenantContext[] = [];
  const client: SqlClient = {
    async query<T>() {
      return { rows: [{ config }] as T[], rowCount: 1 };
    },
  };
  const transaction = { client, tenant: context.tenant };
  const at = new Date();
  const envelope = await encryptCredential(
    kms,
    { orgId: context.tenant.orgId, providerCode: "deepseek", credentialId },
    Buffer.from("fixture-active-secret-1234"),
  );
  await store.stageCredential(
    {
      id: credentialId,
      orgId: context.tenant.orgId,
      providerCode: "deepseek",
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
  await store.activateCredential(credentialId, context.tenant.staffId, at, transaction);
  const base = createByokRuntime(local, kms, store);
  const runtime: ByokRuntime = {
    ...base,
    local: { ...local, pool: {} as PgPool },
    async transact(tenant, operation) {
      tenants.push(tenant);
      return operation({ tenant, client });
    },
  };
  let requests = 0;
  const resolver = createRuntimeProviderResolver(runtime, {
    async request() {
      requests++;
      return {
        status: 200,
        contentType: "text/event-stream",
        body: (async function* () {
          yield Buffer.from(
            'data: {"choices":[{"delta":{"content":"安全回复"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
          );
        })(),
      };
    },
  });
  return {
    resolver,
    store,
    transaction,
    tenants,
    requests: () => requests,
    setConfig: (next: AiRuntimeConfig | null) => {
      config = next;
    },
  };
}
const request = {
  messages: [{ role: "user" as const, content: "hello" }],
  tools: [],
  maxOutputTokens: 20,
  signal: AbortSignal.timeout(1000),
};
async function consume(
  provider: NonNullable<Awaited<ReturnType<ReturnType<typeof createRuntimeProviderResolver>>>>,
) {
  const events = [];
  for await (const event of provider.stream(request)) events.push(event);
  return events;
}

test("real provider resolves tenant-bound active credentials and fails closed after revoke", async () => {
  const f = await fixture();
  const provider = await f.resolver(context);
  assert.ok(provider);
  assert.equal(provider.kind, "openai_compatible");
  assert.ok((await consume(provider)).some((event) => event.type === "delta"));
  assert.equal(f.requests(), 1);
  await f.store.revokeCredential(credentialId, context.tenant.staffId, new Date(), f.transaction);
  assert.ok((await consume(provider)).some((event) => event.type === "error"));
  assert.equal(f.requests(), 1);
  assert.ok(f.tenants.every((tenant) => tenant.orgId === context.tenant.orgId));
});
test("model/version changes, disabled configuration and missing permission never call provider", async () => {
  const f = await fixture();
  const provider = await f.resolver(context);
  assert.ok(provider);
  f.setConfig({ ...settings, version: 2, model_id: "changed" });
  assert.ok((await consume(provider)).some((event) => event.type === "error"));
  assert.equal(f.requests(), 0);
  assert.equal(await f.resolver({ ...context, permissions: [] }), null);
  f.setConfig({ ...settings, enabled: false });
  assert.equal(await f.resolver(context), null);
  f.setConfig(null);
  assert.equal(await f.resolver(context), null);
});
test("foreign tenant cannot acquire another organization's active key", async () => {
  const f = await fixture();
  assert.equal(
    await f.resolver({
      ...context,
      tenant: { ...context.tenant, orgId: "77777777-7777-4777-8777-777777777777" },
    }),
    null,
  );
  assert.equal(f.requests(), 0);
});
test("streaming service resolves configuration at creation and turn execution, not globally", async () => {
  const calls: string[] = [];
  const service = createAiStreamingService({
    store: new MemoryAiConversationStore(),
    provider: null,
    providerResolver: async (current) => {
      calls.push(current.tenant.orgId);
      return null;
    },
    tool: deterministicSyntheticTool,
  });
  assert.equal(service.enabled, true);
  await assert.rejects(service.createSession(context), /AI_UNAVAILABLE/u);
  assert.deepEqual(calls, [context.tenant.orgId]);
});
