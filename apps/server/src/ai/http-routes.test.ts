import assert from "node:assert/strict";
import test from "node:test";

import { CSRF_HEADER_NAME } from "@laundry/contracts";

import {
  createAiService,
  createMemoryAiCredentialStore,
  createStaticKekProvider,
  type AiProvider,
} from "./index.js";
import { createLocalApp } from "../http/create-app.js";
import { resolveCookiePolicy } from "../http/cookie-policy.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";

const DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const provider: AiProvider = Object.freeze({
  async *chat() {
    yield Object.freeze({ type: "text_delta" as const, text: "只读回答" });
    yield Object.freeze({ type: "done" as const });
  },
  async verifyKey() {
    return Object.freeze({ ok: true as const });
  },
});

function parseSetCookie(headers: Record<string, unknown>): Record<string, string> {
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const result: Record<string, string> = {};
  for (const line of list) {
    const [pair] = line.split(";");
    if (pair === undefined) continue;
    const index = pair.indexOf("=");
    if (index > 0) result[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return result;
}

test("BYOK HTTP routes validate input, use the session tenant, and never return the API key", async () => {
  const runtime = await createMemoryLocalRuntime();
  const service = createAiService({
    credentialStore: createMemoryAiCredentialStore(),
    kekProvider: createStaticKekProvider("test-v1", Buffer.alloc(32, 3)),
    provider,
  });
  const policy = resolveCookiePolicy({ secure: false });
  const app = await createLocalApp({ runtime, cookiePolicy: policy, aiService: service });
  const login = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    payload: {
      org_code: "hongfa",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: DEVICE,
    },
  });
  const accessToken = (login.json() as { data: { access_token: string } }).data.access_token;
  const cookies = parseSetCookie(login.headers as Record<string, unknown>);
  const csrf = cookies[policy.csrfName] ?? "";
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  const headers = { authorization: `Bearer ${accessToken}`, [CSRF_HEADER_NAME]: csrf, cookie };

  const rejected = await app.inject({
    method: "POST",
    url: "/api/v2/ai/credentials",
    headers,
    payload: { provider: "openai", api_key: "sk-test-never-log-1234", org_id: "attacker" },
  });
  assert.equal(rejected.statusCode, 400);

  const saved = await app.inject({
    method: "POST",
    url: "/api/v2/ai/credentials",
    headers,
    payload: { provider: "openai", api_key: "sk-test-never-log-1234" },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.body.includes("sk-test-never-log-1234"), false);
  const credentialId = (saved.json() as { data: { credential_id: string; last4: string } }).data;
  assert.equal(credentialId.last4, "1234");

  const verified = await app.inject({
    method: "POST",
    url: `/api/v2/ai/credentials/${credentialId.credential_id}/verify`,
    headers,
  });
  assert.deepEqual(verified.json(), { ok: true, data: { verified: true } });

  const chat = await app.inject({
    method: "POST",
    url: "/api/v2/ai/chat",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      credential_id: credentialId.credential_id,
      preset: "procedure_help",
      message: "怎样开单？",
    },
  });
  assert.equal(chat.statusCode, 200, chat.body);
  assert.match(chat.headers["content-type"] ?? "", /text\/event-stream/u);
  assert.equal(chat.body.includes("只读回答"), true);
  assert.equal(chat.body.includes("sk-test-never-log-1234"), false);
  await app.close();
});
