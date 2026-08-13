import assert from "node:assert/strict";
import test from "node:test";

import { createHttpCommandClient } from "./command-client.js";
import { createHttpQueryClient } from "./query-client.js";

function abortableFetch(calls: RequestInit[]): typeof fetch {
  return async (_input, init = {}) => {
    calls.push(init);
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        {
          once: true,
        },
      );
    });
  };
}

test("aborted query is distinct from a network failure and is never applied", async () => {
  const calls: RequestInit[] = [];
  const client = createHttpQueryClient({
    apiBaseUrl: "https://laundry.example",
    getAccessToken: () => "private.access.token",
    readCsrf: () => "csrf-cookie",
    fetchImpl: abortableFetch(calls),
  });
  const controller = new AbortController();
  const resultPromise = client.execute("delivery.tasks.list", {}, { signal: controller.signal });

  controller.abort();
  const result = await resultPromise;

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.signal, controller.signal);
  assert.deepEqual(result, {
    ok: false,
    error: { code: "REQUEST_ABORTED", message: "请求已取消" },
  });
});

test("aborted command does not auto-replay and an explicit retry keeps one idempotency key", async () => {
  const keys: Array<string | null> = [];
  let calls = 0;
  const fetchImpl: typeof fetch = async (_input, init = {}) => {
    calls += 1;
    keys.push(new Headers(init.headers).get("idempotency-key"));
    if (calls === 1) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }
    return new Response(JSON.stringify({ ok: true, data: { execution: "executed" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createHttpCommandClient({
    apiBaseUrl: "https://laundry.example",
    getAccessToken: () => "private.access.token",
    readCsrf: () => "csrf-cookie",
    newIdempotencyKey: () => "99999999-9999-4999-8999-999999999999",
    fetchImpl,
  });
  const body = Object.freeze({
    delivery_task_id: "11111111-1111-4111-8111-111111111111",
    expected_version: 1,
    decision: "accept",
  });
  const controller = new AbortController();
  const first = client.execute("delivery.task.respond", body, { signal: controller.signal });

  controller.abort();
  const aborted = await first;

  assert.equal(calls, 1, "transport cancellation must not trigger an automatic write replay");
  assert.deepEqual(aborted, {
    ok: false,
    error: { code: "REQUEST_ABORTED", message: "请求已取消" },
  });
  assert.equal((await client.execute("delivery.task.respond", body)).ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(keys, [
    "99999999-9999-4999-8999-999999999999",
    "99999999-9999-4999-8999-999999999999",
  ]);
});
