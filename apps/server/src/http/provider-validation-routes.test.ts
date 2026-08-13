import assert from "node:assert/strict";
import test from "node:test";

import { CSRF_HEADER_NAME } from "@laundry/contracts";

import { encryptCredential } from "../ai/byok-envelope.js";
import { MemoryByokStore } from "../ai/byok-memory-store.js";
import { TestByokKms } from "../ai/byok-test-kms.js";
import type { StoredCredential } from "../ai/byok-types.js";
import type {
  ProviderHttpPort,
  ProviderHttpRequest,
  ProviderHttpResponse,
} from "../ai/provider-http.js";
import type { SqlClient } from "../db/types.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import { DEFAULT_STORE_FEATURES } from "../platform/features.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const DEVICE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CREDENTIAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOST = Object.freeze({ host: "127.0.0.1:8787" });
const MUTATION = Object.freeze({
  ...HOST,
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});
const cookies = resolveCookiePolicy({ secure: false });
const memoryClient: SqlClient = Object.freeze({
  memoryTransaction: true as const,
  async query<TRow = unknown>() {
    return Object.freeze({ rows: Object.freeze([]) as readonly TRow[], rowCount: 0 });
  },
});

async function* body(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value);
}

class ModelFixtureHttp implements ProviderHttpPort {
  readonly requests: ProviderHttpRequest[] = [];

  constructor(private readonly modelId: string) {}

  async request(input: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(input);
    return Object.freeze({
      status: 200,
      contentType: "application/json",
      body: body(
        JSON.stringify({
          object: "list",
          data: [{ id: this.modelId, object: "model", created: 1, owned_by: "fixture" }],
        }),
      ),
    });
  }
}

type BrowserSession = Readonly<{ token: string; cookie: string; csrf: string }>;

function cookieValues(headers: Record<string, unknown>): Record<string, string> {
  const raw = headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return Object.fromEntries(
    values.flatMap((line) => {
      const pair = line.split(";", 1)[0];
      if (pair === undefined) return [];
      const separator = pair.indexOf("=");
      return separator > 0 ? [[pair.slice(0, separator), pair.slice(separator + 1)]] : [];
    }),
  );
}

async function login(app: Awaited<ReturnType<typeof createLocalApp>>): Promise<BrowserSession> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: MUTATION,
    payload: {
      org_code: "local",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: DEVICE_ID,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const parsed = response.json() as Readonly<{ data: Readonly<{ access_token: string }> }>;
  const values = cookieValues(response.headers as Record<string, unknown>);
  return Object.freeze({
    token: parsed.data.access_token,
    cookie: Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
    csrf: values[LOCAL_COOKIE_NAMES.csrf] ?? "",
  });
}

function authHeaders(session: BrowserSession): Record<string, string> {
  return {
    ...MUTATION,
    authorization: `Bearer ${session.token}`,
    cookie: session.cookie,
    [CSRF_HEADER_NAME]: session.csrf,
  };
}

async function build(modelId: string, ai = true) {
  const base = await createMemoryLocalRuntime();
  const runtime: LocalRuntime = Object.freeze({
    ...base,
    pendingStore: new MemoryPendingActionStore(),
  });
  await runtime.platform.features.put?.(LOCAL_PROFILE.storeId, {
    ...DEFAULT_STORE_FEATURES,
    ai,
  });
  const kms = new TestByokKms();
  const store = new MemoryByokStore();
  const envelope = await encryptCredential(
    kms,
    { orgId: LOCAL_PROFILE.orgId, providerCode: "deepseek", credentialId: CREDENTIAL_ID },
    Buffer.from("fixture-provider-credential-1234"),
  );
  const createdAt = new Date(runtime.identity.sessions.clock.nowEpochSeconds() * 1_000);
  const record: StoredCredential = Object.freeze({
    id: CREDENTIAL_ID,
    orgId: LOCAL_PROFILE.orgId,
    providerCode: "deepseek",
    credentialVersion: 1,
    rowVersion: 1,
    status: "pending_verification",
    envelope,
    last4: "1234",
    createdByStaffId: LOCAL_PROFILE.adminStaffId,
    createdAt,
    updatedByStaffId: LOCAL_PROFILE.adminStaffId,
    updatedAt: createdAt,
    activatedAt: null,
    revokedAt: null,
    supersededAt: null,
  });
  await store.stageCredential(record, {
    tenant: {
      orgId: LOCAL_PROFILE.orgId,
      storeId: LOCAL_PROFILE.storeId,
      staffId: LOCAL_PROFILE.adminStaffId,
    },
    client: memoryClient,
  });
  const http = new ModelFixtureHttp(modelId);
  const app = await createLocalApp({
    runtime,
    cookiePolicy: cookies,
    logger: false,
    byokKms: kms,
    byokStore: store,
    aiProviderHttp: http,
  });
  return { app, runtime, store, http };
}

async function createIntent(
  app: Awaited<ReturnType<typeof createLocalApp>>,
  session: BrowserSession,
  modelId: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/v2/ai/provider-validation-intents",
    headers: authHeaders(session),
    payload: {
      credential_ref: CREDENTIAL_ID,
      model_id: modelId,
      idempotency_key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
  });
}

test("confirmed provider validation atomically activates an unchanged pending credential", async (t) => {
  const { app, store, http } = await build("deepseek-v4-pro");
  t.after(() => app.close());
  const session = await login(app);
  const intent = await createIntent(app, session, "deepseek-v4-pro");
  assert.equal(intent.statusCode, 200, intent.body);
  assert.doesNotMatch(intent.body, /fixture-provider-credential/u);
  const confirmRef = (intent.json() as { data: { confirm_ref: string } }).data.confirm_ref;
  const validated = await app.inject({
    method: "POST",
    url: "/api/v2/ai/provider-connections/validate",
    headers: authHeaders(session),
    payload: { confirm_ref: confirmRef },
  });
  assert.equal(validated.statusCode, 200, validated.body);
  const data = (validated.json() as { data: Record<string, unknown> }).data;
  assert.deepEqual(
    { ...data, validated_at: "<clock>" },
    {
      outcome: "valid",
      provider_code: "deepseek",
      credential_ref: CREDENTIAL_ID,
      credential_version: 1,
      model_id: "deepseek-v4-pro",
      discovered_model_count: 1,
      selected_model_available: true,
      error_code: null,
      validated_at: "<clock>",
    },
  );
  assert.match(String(data.validated_at), /^\d{4}-\d{2}-\d{2}T/u);
  const stored = await store.findCredential(CREDENTIAL_ID, {
    tenant: {
      orgId: LOCAL_PROFILE.orgId,
      storeId: LOCAL_PROFILE.storeId,
      staffId: LOCAL_PROFILE.adminStaffId,
    },
  });
  assert.equal(stored?.status, "active");
  assert.equal(http.requests.length, 1);
});

test("a successful discovery that omits the selected model does not consume or activate", async (t) => {
  const { app, runtime, store } = await build("other-model");
  t.after(() => app.close());
  const session = await login(app);
  const intent = await createIntent(app, session, "deepseek-v4-pro");
  assert.equal(intent.statusCode, 200, intent.body);
  const confirmRef = (intent.json() as { data: { confirm_ref: string } }).data.confirm_ref;
  const validated = await app.inject({
    method: "POST",
    url: "/api/v2/ai/provider-connections/validate",
    headers: authHeaders(session),
    payload: { confirm_ref: confirmRef },
  });
  assert.equal(validated.statusCode, 200, validated.body);
  const data = (validated.json() as { data: Record<string, unknown> }).data;
  assert.equal(data.outcome, "failed");
  assert.equal(data.error_code, "PROVIDER_RESPONSE_INVALID");
  assert.equal(data.selected_model_available, false);
  const tenant = {
    orgId: LOCAL_PROFILE.orgId,
    storeId: LOCAL_PROFILE.storeId,
    staffId: LOCAL_PROFILE.adminStaffId,
  };
  assert.equal(
    (await store.findCredential(CREDENTIAL_ID, { tenant }))?.status,
    "pending_verification",
  );
  assert.equal((await runtime.pendingStore.get(confirmRef, { tenant }))?.status, "pending");
});

test("feature hard-off rejects validation intent before provider network work", async (t) => {
  const { app, http } = await build("deepseek-v4-pro", false);
  t.after(() => app.close());
  const response = await createIntent(app, await login(app), "deepseek-v4-pro");
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(http.requests.length, 0);
});
