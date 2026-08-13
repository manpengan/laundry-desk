import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { FastifyInstance, FastifyReply } from "fastify";

import { CSRF_HEADER_NAME, type AiStreamEvent } from "@laundry/contracts";

import { MemoryAiConversationStore } from "../ai/streaming-memory-store.js";
import { createDeterministicFakeProvider } from "../ai/streaming-provider.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { writeSse } from "./ai-streaming-routes.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOST = Object.freeze({ host: "127.0.0.1:8787" });
const MUTATION = Object.freeze({
  ...HOST,
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});
const cookies = resolveCookiePolicy({ secure: false });

type BrowserSession = Readonly<{ token: string; cookie: string; csrf: string }>;

function cookieValues(headers: Record<string, unknown>): Record<string, string> {
  const raw = headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return Object.fromEntries(
    values.flatMap((line) => {
      const pair = line.split(";", 1)[0];
      const separator = pair?.indexOf("=") ?? -1;
      return pair !== undefined && separator > 0
        ? [[pair.slice(0, separator), pair.slice(separator + 1)]]
        : [];
    }),
  );
}

async function login(app: FastifyInstance, runtime: LocalRuntime): Promise<BrowserSession> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: MUTATION,
    payload: {
      org_code: "local",
      store_code: "main",
      username: "staff",
      password: DEMO_PASSWORD,
      device_id: DEVICE_ID,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as Readonly<{ data: Readonly<{ access_token: string }> }>;
  assert.ok(runtime.identity.sessions.accessTokenSigner.verify(body.data.access_token));
  const values = cookieValues(response.headers as Record<string, unknown>);
  return Object.freeze({
    token: body.data.access_token,
    cookie: Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
    csrf: values[LOCAL_COOKIE_NAMES.csrf] ?? "",
  });
}

function authHeaders(session: BrowserSession, csrf = true): Record<string, string> {
  return {
    ...MUTATION,
    authorization: `Bearer ${session.token}`,
    cookie: session.cookie,
    ...(csrf ? { [CSRF_HEADER_NAME]: session.csrf } : {}),
  };
}

async function buildApp(enabled: boolean) {
  const runtime = await createMemoryLocalRuntime();
  const store = new MemoryAiConversationStore();
  const app = await createLocalApp({
    runtime,
    cookiePolicy: cookies,
    logger: false,
    aiConversationStore: store,
    ...(enabled
      ? {
          aiProvider: createDeterministicFakeProvider([
            {
              events: [
                { type: "delta", text: "流式回答" },
                { type: "end", finishReason: "stop", inputTokens: 2, outputTokens: 2 },
              ],
            },
          ]),
        }
      : {}),
  });
  return { app, runtime, store };
}

test("authenticated staff completes fake SSE end-to-end with durable replay headers", async () => {
  const { app, runtime } = await buildApp(true);
  const session = await login(app, runtime);
  const created = await app.inject({
    method: "POST",
    url: "/api/v2/ai/sessions",
    headers: authHeaders(session),
    payload: {},
  });
  assert.equal(created.statusCode, 201, created.body);
  const sessionId = (created.json() as { data: { session_id: string } }).data.session_id;
  const turn = await app.inject({
    method: "POST",
    url: `/api/v2/ai/sessions/${sessionId}/turns`,
    headers: authHeaders(session),
    payload: {
      idempotency_key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      prompt: "请回答",
      max_output_tokens: 32,
    },
  });
  assert.equal(turn.statusCode, 202, turn.body);

  const stream = await app.inject({
    method: "GET",
    url: `/api/v2/ai/sessions/${sessionId}/stream`,
    headers: { ...HOST, authorization: `Bearer ${session.token}`, "last-event-id": "0" },
  });
  assert.equal(stream.statusCode, 200, stream.body);
  assert.match(String(stream.headers["content-type"]), /^text\/event-stream/iu);
  assert.equal(stream.headers["cache-control"], "no-store, no-transform");
  assert.equal(stream.headers["x-accel-buffering"], "no");
  assert.match(stream.body, /event: content_delta/iu);
  assert.match(stream.body, /event: done/iu);
  assert.doesNotMatch(stream.body, /prompt|请回答/iu);

  const replay = await app.inject({
    method: "GET",
    url: `/api/v2/ai/sessions/${sessionId}/events?after=0&limit=10`,
    headers: { ...HOST, authorization: `Bearer ${session.token}` },
  });
  assert.equal(replay.statusCode, 200, replay.body);
  const replayBody = replay.json() as {
    data: { session: { status: string }; events: AiStreamEvent[] };
  };
  assert.equal(replayBody.data.session.status, "completed");
  assert.deepEqual(
    replayBody.data.events.map((event) => event.type),
    ["content_delta", "done"],
  );
  await app.close();
});

test("default runtime is hard-off and CSRF remains mandatory", async () => {
  const { app, runtime } = await buildApp(false);
  const session = await login(app, runtime);
  const noCsrf = await app.inject({
    method: "POST",
    url: "/api/v2/ai/sessions",
    headers: authHeaders(session, false),
    payload: {},
  });
  assert.equal(noCsrf.statusCode, 403);
  const unavailable = await app.inject({
    method: "POST",
    url: "/api/v2/ai/sessions",
    headers: authHeaders(session),
    payload: {},
  });
  assert.equal(unavailable.statusCode, 503, unavailable.body);
  assert.equal(
    (unavailable.json() as { error: { code: string } }).error.code,
    "RESOURCE_UNAVAILABLE",
  );
  await app.close();
});

test("SSE writer waits for drain when response backpressure is active", async () => {
  const emitter = new EventEmitter();
  let frame = "";
  const raw = Object.assign(emitter, {
    write(value: string) {
      frame += value;
      return false;
    },
  });
  const reply = { raw } as unknown as FastifyReply;
  const event: AiStreamEvent = Object.freeze({
    type: "content_delta",
    cursor: 1,
    turn_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    at: "2026-08-13T00:00:00.000Z",
    text: "bounded",
  });
  let resolved = false;
  const pending = writeSse(reply, event).then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, false);
  emitter.emit("drain");
  await pending;
  assert.equal(resolved, true);
  assert.match(frame, /^id: 1\nevent: content_delta\ndata:/u);
});
