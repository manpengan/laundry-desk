import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopQueryExecuteResultSchema,
  DesktopSessionViewSchema,
  createCommandError,
  type DesktopSessionView,
} from "@laundry/contracts";

import type { DesktopHttpTransport } from "../desktop/http-transport.js";
import type { OfflineReadCache } from "./read-cache.js";
import type { OfflineCommandRuntime } from "./runtime.js";
import { createOfflineDesktopService } from "./service.js";

const unavailable = Object.freeze({
  ok: false as const,
  error: createCommandError("RESOURCE_UNAVAILABLE"),
});
const answer = DesktopQueryExecuteResultSchema.parse({
  ok: true,
  data: { execution: "executed", result: { marker: "only-original-session" } },
});
const input = Object.freeze({ name: "order.list", body: {} });
const originalSession = DesktopSessionViewSchema.parse({
  session: {
    session_id: "10000000-0000-4000-8000-000000000001",
    session_version: 1,
    org_id: "10000000-0000-4000-8000-000000000002",
    store_id: "10000000-0000-4000-8000-000000000003",
    staff_id: "10000000-0000-4000-8000-000000000004",
    device_id: "10000000-0000-4000-8000-000000000005",
    permission_version: 1,
  },
  role: "staff",
  features: { member_enabled: true },
  display: { store_name: "Synthetic", staff_name: "A", org_code: "test", store_code: "test" },
});

function deferred() {
  let release = () => undefined as void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

type Stage = "query" | "maintenance" | "health" | "cache-read" | "cache-write";
type Transition = "switch-staff" | "logout" | "new-session" | "refresh";

function fixture(combined = false, recoveryReadOnly = false) {
  let pausedStage: Stage | null = null;
  let remoteAvailable = true;
  let failCacheWrite = false;
  let refreshedSession: DesktopSessionView | null = null;
  const started = deferred();
  const gate = deferred();
  const transitioned = deferred();
  const writes: DesktopSessionView[] = [];
  const cacheCalls: string[] = [];
  const reads: DesktopSessionView[] = [];
  const reconciled: Array<DesktopSessionView | null> = [];
  const pause = async (stage: Stage) => {
    if (pausedStage !== stage) return;
    pausedStage = null;
    started.release();
    await gate.promise;
  };
  const online = {
    auth: {
      login: async (session: DesktopSessionView) => ({
        ok: true,
        data: { session_view: session, staff_directory: [] },
      }),
      refresh: async () =>
        refreshedSession === null ? unavailable : { ok: true, data: refreshedSession },
      logout: async () => ({ ok: true, data: { logged_out: true } }),
    },
    query: {
      execute: async () => {
        await pause("query");
        return remoteAvailable ? answer : unavailable;
      },
    },
    command: { execute: async () => answer },
    health: {
      get: async () => {
        await pause("health");
        return unavailable;
      },
    },
  } as unknown as DesktopHttpTransport;
  const runtime = {
    refreshAuthority: async () => {
      await pause("maintenance");
      return true;
    },
    replay: async () => undefined,
    exportReadAuthority: () => (combined ? Object.freeze({}) : null),
    reconcileSession: (session: DesktopSessionView | null) => {
      reconciled.push(session);
      if (reconciled.length > 1) transitioned.release();
    },
    invalidateContinuity: () => undefined,
    clearReadAuthority: () => undefined,
  } as unknown as OfflineCommandRuntime;
  const cache = {
    bind: () => {
      cacheCalls.push("bind");
    },
    bindAndPut: async (
      session: DesktopSessionView,
      _authority: unknown,
      _input: unknown,
      _result: unknown,
      isCurrent: () => boolean,
    ) => {
      cacheCalls.push("bindAndPut");
      await pause("cache-write");
      if (!isCurrent()) return false;
      if (failCacheWrite) throw new Error("Synthetic persistence failure");
      writes.push(session);
      return true;
    },
    put: async (session: DesktopSessionView) => {
      cacheCalls.push("put");
      if (failCacheWrite) throw new Error("Synthetic persistence failure");
      writes.push(session);
      await pause("cache-write");
      return true;
    },
    get: async (session: DesktopSessionView) => {
      reads.push(session);
      await pause("cache-read");
      return answer;
    },
    clear: () => undefined,
    resume: () => ({
      sessionView: originalSession,
      cachedQueryCount: 1,
      grantNotAfter: "2026-07-30T12:00:00.000Z",
    }),
  } as unknown as OfflineReadCache;
  const service = createOfflineDesktopService(online, runtime, cache, { recoveryReadOnly });
  return {
    service,
    online,
    writes,
    cacheCalls,
    reads,
    reconciled,
    setCacheFailure: (failed: boolean) => {
      failCacheWrite = failed;
    },
    pauseAt: (stage: Stage) => {
      pausedStage = stage;
      remoteAvailable = stage !== "health" && stage !== "cache-read";
    },
    started: started.promise,
    release: gate.release,
    transition: async (transition: Transition) => {
      if (transition === "logout") return service.auth.logout();
      const next = DesktopSessionViewSchema.parse({
        ...originalSession,
        session: {
          ...originalSession.session,
          session_id:
            transition === "refresh"
              ? originalSession.session.session_id
              : "10000000-0000-4000-8000-000000000006",
          staff_id:
            transition === "switch-staff"
              ? "10000000-0000-4000-8000-000000000007"
              : originalSession.session.staff_id,
        },
      });
      refreshedSession = transition === "refresh" ? originalSession : next;
      const pending = transition === "refresh" ? service.auth.refresh() : service.auth.login(next);
      await transitioned.promise;
      return { pending };
    },
  };
}

for (const stage of ["query", "maintenance", "health", "cache-read", "cache-write"] as const) {
  for (const transition of ["switch-staff", "logout", "new-session", "refresh"] as const) {
    test(`a query cannot cross ${transition} while awaiting ${stage}`, async () => {
      const f = fixture();
      await f.service.auth.login(originalSession);
      f.pauseAt(stage);
      const pending = f.service.query.execute(input);
      await f.started;
      const changed = await f.transition(transition);
      f.release();
      const result = await pending;
      if (changed && typeof changed === "object" && "pending" in changed) await changed.pending;
      assert.ok(
        f.writes.every((session) => session === originalSession),
        "old data must not be written under a replacement session",
      );
      assert.ok(
        f.reads.every((session) => session === originalSession),
        "old requests must not read a replacement session cache",
      );
      assert.deepEqual(result, {
        ok: false,
        error: createCommandError("RESOURCE_UNAVAILABLE", {
          kind: "reason",
          reason: "retry_later",
        }),
      });
    });
  }
}

test("one resumed session can promote concurrently to online without invalidating its own queries", async () => {
  const f = fixture();
  await f.service.offline.resume();
  assert.deepEqual(await f.service.command.execute({}), {
    ok: false,
    error: createCommandError("RESOURCE_UNAVAILABLE", { kind: "reason", reason: "retry_later" }),
  });
  f.pauseAt("query");
  const first = f.service.query.execute(input);
  await f.started;
  const second = await f.service.query.execute(input);
  f.release();
  assert.deepEqual(await first, answer);
  assert.deepEqual(second, answer);
  assert.deepEqual(await f.service.command.execute({}), answer);
  assert.deepEqual(f.writes, [originalSession, originalSession]);
});

test("unchanged online and offline queries retain their original cache identity", async () => {
  const f = fixture();
  await f.service.auth.login(originalSession);
  assert.deepEqual(await f.service.query.execute(input), answer);
  f.pauseAt("health");
  const pending = f.service.query.execute(input);
  await f.started;
  f.release();
  assert.deepEqual(await pending, answer);
  assert.deepEqual(f.writes, [originalSession]);
  assert.deepEqual(f.reads, [originalSession]);
});

for (const transition of ["switch-staff", "logout", "new-session", "refresh"] as const) {
  test(`combined query persistence cannot cross ${transition} during schema parsing`, async () => {
    const f = fixture(true);
    await f.service.auth.login(originalSession);
    f.pauseAt("cache-write");
    const pending = f.service.query.execute(input);
    await f.started;
    const changed = await f.transition(transition);
    f.release();
    assert.deepEqual(await pending, {
      ok: false,
      error: createCommandError("RESOURCE_UNAVAILABLE", { kind: "reason", reason: "retry_later" }),
    });
    if (changed && typeof changed === "object" && "pending" in changed) await changed.pending;
    assert.deepEqual(
      f.writes,
      [],
      "stale queries must not bind or persist after the async boundary",
    );
  });
}

test("concurrent resumed queries keep both fused updates and restore write permission", async () => {
  const f = fixture(true);
  await f.service.offline.resume();
  f.pauseAt("cache-write");
  const first = f.service.query.execute(input);
  await f.started;
  const second = f.service.query.execute(input);
  f.release();
  assert.deepEqual(await Promise.all([first, second]), [answer, answer]);
  assert.deepEqual(f.writes, [originalSession, originalSession]);
  assert.deepEqual(await f.service.command.execute({}), answer);
});

for (const combined of [false, true]) {
  test(`cache persistence failure preserves online success with authority=${combined}`, async () => {
    const f = fixture(combined);
    await f.service.auth.login(originalSession);
    f.setCacheFailure(true);
    assert.deepEqual(await f.service.query.execute(input), answer);
    assert.deepEqual(f.writes, []);
    f.setCacheFailure(false);
    assert.deepEqual(await f.service.query.execute(input), answer);
    assert.deepEqual(f.writes, [originalSession]);
  });
}

test("recovery read-only queries never invoke either persistence path or authority binding", async () => {
  const f = fixture(true, true);
  await f.service.auth.login(originalSession);
  assert.deepEqual(await f.service.query.execute(input), answer);
  assert.deepEqual(f.cacheCalls, []);
});
