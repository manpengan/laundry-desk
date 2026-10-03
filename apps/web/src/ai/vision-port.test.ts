import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopVisionPort, createHttpVisionPort } from "./vision-port.js";
import type { DesktopAiInput } from "@laundry/contracts";
const id = "11111111-1111-4111-8111-111111111111";
const input = {
  request_id: id,
  mode: "assist" as const,
  image_base64: "eA==",
  candidates: [],
  consent: true as const,
};
const success = {
  ok: true,
  data: {
    analysis: { category: "上衣", colors: ["白"], visible_marks: ["无法判断"], comparisons: [] },
    candidates: [],
    turn_id: id,
    advisory_only: true,
  },
};
test("desktop vision uses finite operation and cancels request ID on abort", async () => {
  const calls: DesktopAiInput[] = [];
  let finish: (value: unknown) => void = () => undefined;
  const port = createDesktopVisionPort(async (op) => {
    calls.push(op);
    return op.operation === "cancel"
      ? { ok: true, data: { cancelled: true } }
      : await new Promise((resolve) => {
          finish = resolve;
        });
  });
  const abort = new AbortController();
  const pending = port.analyze(input, abort.signal);
  abort.abort();
  finish(success);
  assert.equal((await pending).ok, false);
  assert.deepEqual(
    calls.map((c) => c.operation),
    ["visionAnalyze", "cancel"],
  );
  assert.deepEqual(calls[1], { operation: "cancel", session_id: id });
});
test("HTTP vision pins routes/CSRF and rejects changed login results", async () => {
  let token = "first";
  let requestCount = 0;
  const port = createHttpVisionPort({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => token,
    readCsrf: () => "csrf",
    fetchImpl: async (url, init) => {
      requestCount++;
      assert.equal(url, "http://127.0.0.1:8787/api/v2/ai/vision/analyze");
      assert.equal(new Headers(init?.headers).get("x-csrf-token"), "csrf");
      token = "second";
      return new Response(JSON.stringify(success), { status: 200 });
    },
  });
  assert.equal((await port.analyze(input, new AbortController().signal)).ok, false);
  assert.equal(requestCount, 1);
  assert.equal(
    (
      await port.analyze(
        { ...input, consent: false } as unknown as typeof input,
        new AbortController().signal,
      )
    ).ok,
    false,
  );
  assert.equal(requestCount, 1);
});
