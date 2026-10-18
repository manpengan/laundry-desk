import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopCommandExecuteResultSchema,
  DesktopOfflineResumeResultSchema,
  DesktopQueryExecuteResultSchema,
  DesktopSessionViewSchema,
  createCommandError,
  type DesktopSessionView,
} from "@laundry/contracts";

import { createDesktopHttpTransport } from "../desktop/http-transport.js";
import type { OfflineReadCache } from "./read-cache.js";
import type { OfflineCommandRuntime } from "./runtime.js";
import { session } from "./runtime-test-fixtures.js";
import { createOfflineDesktopService } from "./service.js";

const query = Object.freeze({ name: "customer.search", body: { query: "synthetic" } });
const command = Object.freeze({
  name: "customer.upsert",
  body: { name: "Synthetic", phone: "13600000000" },
});
const answer = DesktopQueryExecuteResultSchema.parse({
  ok: true,
  data: { execution: "executed", result: { customers: [] } },
});
const failure = (code: "RESOURCE_UNAVAILABLE" | "AUTHENTICATION_FAILED") => ({
  ok: false as const,
  error:
    code === "RESOURCE_UNAVAILABLE"
      ? createCommandError(code, { kind: "reason", reason: "retry_later" })
      : createCommandError(code),
});
type Mode = "offline" | "online" | "revoked" | "refresh-unavailable";

function deferred() {
  let resolve = () => undefined as void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let mode: Mode = "offline";
  let refreshedSession = session;
  let cached = true;
  let clearCount = 0;
  let cacheReads = 0;
  let replays = 0;
  let requests: readonly string[] = [];
  let logoutPaused = false;
  const logoutStarted = deferred();
  const logoutGate = deferred();
  const online = createDesktopHttpTransport({
    deviceId: session.session.device_id,
    cookies: {
      get: async () => [{ name: "laundry_csrf", value: `v1.${"a".repeat(43)}` }],
      clear: async () => undefined,
    },
    request: async (request) => {
      const path = new URL(request.url).pathname;
      requests = [...requests, path];
      if (path === "/api/v2/auth/logout") {
        logoutStarted.resolve();
        if (logoutPaused) await logoutGate.promise;
        return {
          statusCode: 200,
          bodyText: JSON.stringify({ ok: true, data: { logged_out: true } }),
        };
      }
      if (mode === "offline") throw new Error("Synthetic network outage");
      if (path === "/health") {
        return {
          statusCode: 200,
          bodyText: JSON.stringify({ ok: true, data: { status: "ready" } }),
        };
      }
      if (path === "/api/v2/auth/refresh") {
        if (mode === "refresh-unavailable") throw new Error("Synthetic refresh outage");
        if (mode === "revoked") {
          return { statusCode: 401, bodyText: JSON.stringify(failure("AUTHENTICATION_FAILED")) };
        }
        return {
          statusCode: 200,
          bodyText: JSON.stringify({
            ok: true,
            data: {
              ...refreshedSession,
              access_token: "synthetic.access.token",
              token_type: "Bearer",
              expires_in: 900,
              storage: "memory_only",
            },
          }),
        };
      }
      return { statusCode: 200, bodyText: JSON.stringify(answer) };
    },
  });
  const runtime = {
    refreshAuthority: async () => false,
    replay: async () => {
      replays += 1;
    },
    exportReadAuthority: () => null,
    invalidateContinuity: () => undefined,
    clearReadAuthority: () => undefined,
    reconcileSession: () => undefined,
  } as unknown as OfflineCommandRuntime;
  const cache = {
    resume: () => ({
      sessionView: session,
      cachedQueryCount: 1,
      grantNotAfter: "2099-01-01T00:00:00Z",
    }),
    get: async (current: DesktopSessionView, input: unknown) => {
      cacheReads += 1;
      assert.deepEqual(current, session);
      assert.deepEqual(input, query);
      return cached ? answer : null;
    },
    put: async () => true,
    clear: () => {
      clearCount += 1;
    },
  } as unknown as OfflineReadCache;
  return {
    service: createOfflineDesktopService(online, runtime, cache),
    online,
    setMode: (next: Mode) => {
      mode = next;
    },
    setSession: (next: DesktopSessionView) => {
      refreshedSession = next;
    },
    removeCachedResult: () => {
      cached = false;
    },
    pauseLogout: () => {
      logoutPaused = true;
    },
    logoutStarted: logoutStarted.promise,
    releaseLogout: logoutGate.resolve,
    counts: () => ({ clearCount, cacheReads, replays }),
    businessRequests: () => requests.filter((path) => path.startsWith("/v1/")),
  };
}

test("real HTTP transport reads a resumed cold-start cache without an access token", async () => {
  const f = fixture();
  assert.deepEqual(await f.online.query.execute(query), failure("AUTHENTICATION_FAILED"));
  const resumed = DesktopOfflineResumeResultSchema.parse(await f.service.offline.resume());
  assert.equal(resumed.ok, true);
  assert.deepEqual(await f.service.query.execute(query), answer);
  assert.equal(
    DesktopCommandExecuteResultSchema.parse(await f.service.command.execute(command)).ok,
    false,
  );
  assert.deepEqual(f.counts(), { clearCount: 0, cacheReads: 1, replays: 0 });
  assert.deepEqual(f.businessRequests(), []);
});

test("a cold-start cache miss remains unavailable and never enables writes", async () => {
  const f = fixture();
  await f.service.offline.resume();
  f.removeCachedResult();
  assert.deepEqual(await f.service.query.execute(query), failure("RESOURCE_UNAVAILABLE"));
  assert.equal(
    DesktopCommandExecuteResultSchema.parse(await f.service.command.execute(command)).ok,
    false,
  );
  assert.deepEqual(f.counts(), { clearCount: 0, cacheReads: 1, replays: 0 });
});

for (const mode of ["revoked", "refresh-unavailable"] as const) {
  test(`cold-start cache is discarded after ${mode} with a reachable service`, async () => {
    const f = fixture();
    await f.service.offline.resume();
    f.setMode(mode);
    assert.deepEqual(
      await f.service.query.execute(query),
      failure(mode === "revoked" ? "AUTHENTICATION_FAILED" : "RESOURCE_UNAVAILABLE"),
    );
    assert.deepEqual(f.counts(), { clearCount: 1, cacheReads: 0, replays: 0 });
  });
}

test("matching refresh restores online reads and permits subsequent normal commands", async () => {
  const f = fixture();
  await f.service.offline.resume();
  f.setMode("online");
  assert.deepEqual(await f.service.query.execute(query), answer);
  assert.equal(
    DesktopCommandExecuteResultSchema.parse(await f.service.command.execute(command)).ok,
    true,
  );
  assert.deepEqual(f.businessRequests(), [
    "/v1/queries/customer.search",
    "/v1/commands/customer.upsert",
  ]);
  assert.deepEqual(f.counts(), { clearCount: 0, cacheReads: 0, replays: 2 });
});

const identityKeys = [
  "session_id",
  "session_version",
  "org_id",
  "store_id",
  "staff_id",
  "device_id",
  "permission_version",
] as const;
for (const field of [...identityKeys, "role"] as const) {
  test(`a resumed query rejects changed ${field} and clears transport credentials`, async () => {
    const f = fixture();
    await f.service.offline.resume();
    const changed =
      field === "role"
        ? { ...session, role: "admin" }
        : {
            ...session,
            session: {
              ...session.session,
              [field]:
                typeof session.session[field] === "number"
                  ? 2
                  : "00000000-0000-4000-8000-000000000099",
            },
          };
    f.setSession(DesktopSessionViewSchema.parse(changed));
    f.setMode("online");
    assert.equal(
      DesktopQueryExecuteResultSchema.parse(await f.service.query.execute(query)).ok,
      false,
    );
    assert.deepEqual(await f.service.query.execute(query), failure("AUTHENTICATION_FAILED"));
    assert.deepEqual(await f.service.command.execute(command), failure("AUTHENTICATION_FAILED"));
    assert.deepEqual(f.businessRequests(), []);
    assert.deepEqual(f.counts(), { clearCount: 1, cacheReads: 0, replays: 0 });
  });
}

test("identity rejection disables transport commands before logout HTTP completes", async () => {
  const f = fixture();
  await f.service.offline.resume();
  f.setSession(DesktopSessionViewSchema.parse({ ...session, role: "admin" }));
  f.setMode("online");
  f.pauseLogout();
  const pending = f.service.query.execute(query);
  try {
    await f.logoutStarted;
    assert.deepEqual(await f.service.query.execute(query), failure("AUTHENTICATION_FAILED"));
    assert.deepEqual(await f.service.command.execute(command), failure("AUTHENTICATION_FAILED"));
    assert.deepEqual(f.businessRequests(), []);
  } finally {
    f.releaseLogout();
  }
  assert.equal(DesktopQueryExecuteResultSchema.parse(await pending).ok, false);
});
