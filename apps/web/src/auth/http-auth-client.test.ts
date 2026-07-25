/**
 * HttpAuthClient unit tests with a fake fetch (no network).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createHttpAuthClient } from "./HttpAuthClient.js";

const ADMIN_STAFF_ID = "11111111-1111-4111-8111-111111111103";

function staffDirectoryResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data: [
        {
          staff_id: ADMIN_STAFF_ID,
          display_name: "店长",
          role: "admin",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function loginResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data: {
        access_token: "aaa.bbb.ccc",
        token_type: "Bearer",
        expires_in: 900,
        storage: "memory_only",
        session: {
          session_id: "s1",
          session_version: 1,
          org_id: "o1",
          store_id: "st1",
          staff_id: ADMIN_STAFF_ID,
          device_id: "d1",
          permission_version: 1,
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function assertSecondLoginRejectsStaleDirectory(
  secondDirectory: () => Response | Promise<Response>,
): Promise<void> {
  let directoryCalls = 0;
  let loginCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/local/staff")) {
      directoryCalls += 1;
      return directoryCalls === 1 ? staffDirectoryResponse() : secondDirectory();
    }
    if (url.endsWith("/api/v2/auth/login") && init?.method === "POST") {
      loginCalls += 1;
      return loginResponse();
    }
    return new Response("not found", { status: 404 });
  };
  const client = createHttpAuthClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    fetchImpl,
  });
  const credentials = {
    org_code: "local",
    store_code: "main",
    username: "admin",
    password: "fixture-password",
  };

  const first = await client.login(credentials);
  const second = await client.login(credentials);

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.match(second.error.message, /员工目录/u);
  }
  assert.equal(loginCalls, 1, "a stale directory must stop the second login request");
}

test("login uses the server staff projection without client-side product mapping", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/local/staff")) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: [
            {
              staff_id: "11111111-1111-4111-8111-111111111103",
              display_name: "店长",
              role: "admin",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/api/v2/auth/login") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            access_token: "aaa.bbb.ccc",
            token_type: "Bearer",
            expires_in: 900,
            storage: "memory_only",
            session: {
              session_id: "s1",
              session_version: 1,
              org_id: "o1",
              store_id: "st1",
              staff_id: "11111111-1111-4111-8111-111111111103",
              device_id: "d1",
              permission_version: 1,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  };

  const client = createHttpAuthClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    fetchImpl,
  });
  const result = await client.login({
    org_code: "local",
    store_code: "main",
    username: "admin",
    password: "fixture-password",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.storage, "memory_only");
    assert.equal(result.data.role, "admin");
    assert.equal(result.data.access_token, "aaa.bbb.ccc");
    assert.equal(result.data.display.store_name, "");
    assert.equal(result.data.display.staff_name, "店长");
  }
});

test("second login rejects a network failure instead of reusing the prior staff directory", async () => {
  await assertSecondLoginRejectsStaleDirectory(() => {
    throw new Error("directory offline");
  });
});

test("second login rejects an invalid staff directory instead of reusing prior roles", async () => {
  await assertSecondLoginRejectsStaleDirectory(
    () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: [{ staff_id: ADMIN_STAFF_ID, display_name: "旧店长", role: "owner" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
});

test("second login rejects a non-2xx staff directory instead of reusing prior roles", async () => {
  await assertSecondLoginRejectsStaleDirectory(
    () =>
      new Response(JSON.stringify({ ok: false }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
  );
});

test("login rejects a missing server staff projection instead of inferring a role", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/local/staff")) {
      return new Response(JSON.stringify({ ok: true, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/v2/auth/login") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            access_token: "aaa.bbb.ccc",
            expires_in: 900,
            session: {
              session_id: "s1",
              session_version: 1,
              org_id: "o1",
              store_id: "st1",
              staff_id: "11111111-1111-4111-8111-111111111103",
              device_id: "d1",
              permission_version: 1,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  };

  const client = createHttpAuthClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    fetchImpl,
  });
  const result = await client.login({
    org_code: "local",
    store_code: "main",
    username: "admin",
    password: "fixture-password",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /员工权限/u);
  }
});

test("login surfaces network failure message", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("offline");
  };
  const client = createHttpAuthClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    fetchImpl,
  });
  const result = await client.login({
    org_code: "local",
    store_code: "main",
    username: "admin",
    password: "fixture-password",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /本地服务器/);
  }
});
