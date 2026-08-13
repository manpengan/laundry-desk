import assert from "node:assert/strict";
import test from "node:test";

import { createHttpAiPanelPort } from "./ai-port.js";

function streamResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

test("browser AI port posts with host-owned auth/CSRF then parses split SSE frames", async () => {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url.endsWith("/api/v2/ai/sessions")) {
      return Response.json({
        ok: true,
        data: {
          session_id: "11111111-1111-4111-8111-111111111111",
          status: "open",
          created_at: "2026-08-13T00:00:00.000Z",
          updated_at: "2026-08-13T00:00:00.000Z",
        },
      });
    }
    if (request.url.endsWith("/turns")) {
      return Response.json({
        ok: true,
        data: {
          turn_id: "22222222-2222-4222-8222-222222222222",
          session_id: "11111111-1111-4111-8111-111111111111",
          status: "queued",
          stream_url: "/api/v2/ai/sessions/11111111-1111-4111-8111-111111111111/stream",
          replayed: false,
          created_at: "2026-08-13T00:00:00.000Z",
        },
      });
    }
    return streamResponse([
      'id: 1\nevent: content_delta\ndata: {"type":"content_delta","cursor":1,',
      '"turn_id":"22222222-2222-4222-8222-222222222222","at":"2026-08-13T00:00:00.000Z","text":"plain"}\n\n',
      ": keepalive\n\n",
      'id: 2\nevent: done\ndata: {"type":"done","cursor":2,"turn_id":"22222222-2222-4222-8222-222222222222","at":"2026-08-13T00:00:00.000Z","finish_reason":"stop","input_tokens":1,"output_tokens":1}\n\n',
    ]);
  };
  const port = createHttpAiPanelPort({
    apiBaseUrl: "http://127.0.0.1:8787/",
    fetchImpl,
    getAccessToken: () => "access-token",
    readCsrf: () => "csrf-proof",
  });
  const session = await port.createSession();
  assert.equal(session.ok, true);
  if (!session.ok) return;
  const turn = await port.createTurn(session.data.sessionId, {
    prompt: "hello",
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
  });
  assert.equal(turn.ok, true);
  const events: string[] = [];
  const streamed = await port.stream(
    session.data.sessionId,
    0,
    new AbortController().signal,
    (event) => events.push(event.type),
  );
  assert.deepEqual(events, ["content_delta", "done"]);
  assert.deepEqual(streamed, { ok: true, data: { cursor: 2 } });
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer access-token");
  assert.equal(requests[0]?.headers.get("x-csrf-token"), "csrf-proof");
  assert.equal(requests[2]?.headers.get("last-event-id"), "0");
  assert.equal(requests[2]?.headers.get("accept"), "text/event-stream");
});

test("browser AI port treats an explicit AbortSignal as a clean stop", async () => {
  const abort = new AbortController();
  abort.abort();
  const port = createHttpAiPanelPort({
    apiBaseUrl: "http://127.0.0.1:8787",
    fetchImpl: async (_input, init) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      throw new Error("expected abort");
    },
    getAccessToken: () => "token",
    readCsrf: () => "csrf",
  });
  assert.deepEqual(
    await port.stream("11111111-1111-4111-8111-111111111111", 7, abort.signal, () => undefined),
    { ok: true, data: { cursor: 7 } },
  );
});
