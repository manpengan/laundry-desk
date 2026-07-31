import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopCommandExecuteResultSchema,
  DesktopHealthGetResultSchema,
  DesktopSessionViewSchema,
  createCommandError,
} from "@laundry/contracts";

import type { DesktopHttpTransport } from "../desktop/http-transport.js";
import type { OfflineCommandRuntime } from "./runtime.js";
import type { OfflineReadCache } from "./read-cache.js";
import { createOfflineDesktopService } from "./service.js";

const serverUnavailable = DesktopCommandExecuteResultSchema.parse({
  ok: false,
  error: createCommandError("RESOURCE_UNAVAILABLE"),
});
const queued = DesktopCommandExecuteResultSchema.parse({
  ok: true,
  data: {
    execution: "executed",
    result: { offline_queued: true },
  },
});

function resultOk(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "ok") === "boolean" &&
    Reflect.get(value, "ok") === true
  );
}

function serviceFixture(
  healthOk: boolean,
  executeCommand: (input: unknown) => Promise<unknown> = async () => serverUnavailable,
) {
  let queueCalls = 0;
  let resolveCalls = 0;
  let replayCalls = 0;
  const online = {
    auth: {
      login: async () => serverUnavailable,
      refresh: async () => serverUnavailable,
      pinChallenge: async () => serverUnavailable,
      pinVerify: async () => serverUnavailable,
      logout: async () => serverUnavailable,
    },
    command: { execute: executeCommand },
    query: { execute: async () => serverUnavailable },
    photo: {
      upload: async () => serverUnavailable,
      read: async () => serverUnavailable,
      delete: async () => serverUnavailable,
    },
    offline: {},
    health: {
      get: async () =>
        DesktopHealthGetResultSchema.parse(
          healthOk
            ? { ok: true, data: { status: "ready" } }
            : { ok: false, error: createCommandError("RESOURCE_UNAVAILABLE") },
        ),
    },
    edge: {
      authority: async () => serverUnavailable,
      replay: async () => serverUnavailable,
    },
  } as unknown as DesktopHttpTransport;
  const offline = {
    queueCommand: async () => {
      queueCalls += 1;
      return queued;
    },
    resolve: () => {
      resolveCalls += 1;
    },
    replay: async () => {
      replayCalls += 1;
    },
    status: () => ({
      ok: true,
      data: { pending_count: 0, inflight_count: 0, conflicts: [] },
    }),
  } as unknown as OfflineCommandRuntime;
  const cache = {
    resume: () => null,
    clear: () => undefined,
  } as unknown as OfflineReadCache;
  return Object.freeze({
    service: createOfflineDesktopService(online, offline, cache),
    queueCalls: () => queueCalls,
    resolveCalls: () => resolveCalls,
    replayCalls: () => replayCalls,
  });
}

test("reachable server business failures are never misclassified as offline work", async () => {
  const fixture = serviceFixture(true);
  assert.deepEqual(await fixture.service.command.execute({}), serverUnavailable);
  assert.equal(fixture.queueCalls(), 0);
});

test("an unavailable command is queued only after the health boundary is also unavailable", async () => {
  const fixture = serviceFixture(false);
  assert.deepEqual(await fixture.service.command.execute({}), queued);
  assert.equal(fixture.queueCalls(), 1);
});

test("discard is locally acknowledged only after the audited R3 confirmation hop", async () => {
  const inputs: unknown[] = [];
  const confirmRef = "00000000-0000-4000-8000-000000000099";
  const results = [
    DesktopCommandExecuteResultSchema.parse({
      ok: false,
      error: createCommandError(
        "POLICY_CONFIRMATION_REQUIRED",
        Object.freeze({ kind: "confirmation", confirm_ref: confirmRef }),
      ),
    }),
    queued,
  ];
  const fixture = serviceFixture(true, async (input) => {
    inputs.push(input);
    return results.shift() ?? serverUnavailable;
  });

  const result = await fixture.service.offline.resolve({
    queue_id: "3a2eed00-a6c3-493c-a3a7-20bf94b1d678",
    action: "discard",
    reason: "operator reconciled the ledger",
    confirm: "DISCARD",
  });

  assert.equal((result as Readonly<{ ok: boolean }>).ok, true);
  assert.deepEqual(inputs, [
    {
      name: "edge.conflict.discard",
      body: {
        queue_id: "3a2eed00-a6c3-493c-a3a7-20bf94b1d678",
        reason: "operator reconciled the ledger",
        confirm: "DISCARD",
      },
    },
    { name: "edge.conflict.discard", confirm_ref: confirmRef },
  ]);
  assert.equal(fixture.resolveCalls(), 1);
  assert.equal(fixture.replayCalls(), 0);
});

test("failed discard audit leaves the local queue and conflict untouched", async () => {
  const fixture = serviceFixture(true);
  const result = await fixture.service.offline.resolve({
    queue_id: "3a2eed00-a6c3-493c-a3a7-20bf94b1d678",
    action: "discard",
    reason: "operator reconciled the ledger",
    confirm: "DISCARD",
  });

  assert.equal((result as Readonly<{ ok: boolean }>).ok, false);
  assert.equal(fixture.resolveCalls(), 0);
});

const resumedSession = DesktopSessionViewSchema.parse({
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
  display: {
    store_name: "本地门店",
    staff_name: "店员",
    org_code: "local",
    store_code: "main",
  },
});

test("recovery read-only remains immutable across session refreshes and blocks every write surface", async () => {
  const calls = {
    login: 0,
    refresh: 0,
    logout: 0,
    command: 0,
    query: 0,
    pinChallenge: 0,
    pinVerify: 0,
    photoUpload: 0,
    photoRead: 0,
    photoDelete: 0,
    refreshAuthority: 0,
    replay: 0,
    queue: 0,
    resolve: 0,
    status: 0,
    health: 0,
    cacheBind: 0,
    cachePut: 0,
  };
  const allowed = Object.freeze({ ok: true as const, data: Object.freeze({ accepted: true }) });
  const online = {
    auth: {
      login: async () => {
        calls.login += 1;
        return { ok: true as const, data: { session_view: resumedSession, staff_directory: [] } };
      },
      refresh: async () => {
        calls.refresh += 1;
        return { ok: true as const, data: resumedSession };
      },
      pinChallenge: async () => {
        calls.pinChallenge += 1;
        return allowed;
      },
      pinVerify: async () => {
        calls.pinVerify += 1;
        return allowed;
      },
      logout: async () => {
        calls.logout += 1;
        return allowed;
      },
    },
    command: {
      execute: async () => {
        calls.command += 1;
        return serverUnavailable;
      },
    },
    query: {
      execute: async () => {
        calls.query += 1;
        return allowed;
      },
    },
    photo: {
      upload: async () => {
        calls.photoUpload += 1;
        return allowed;
      },
      read: async () => {
        calls.photoRead += 1;
        return allowed;
      },
      delete: async () => {
        calls.photoDelete += 1;
        return allowed;
      },
    },
    health: {
      get: async () => {
        calls.health += 1;
        return serverUnavailable;
      },
    },
    edge: {
      authority: async () => allowed,
      replay: async () => allowed,
    },
  } as unknown as DesktopHttpTransport;
  const offline = {
    refreshAuthority: async () => {
      calls.refreshAuthority += 1;
      return true;
    },
    replay: async () => {
      calls.replay += 1;
    },
    queueCommand: async () => {
      calls.queue += 1;
      return queued;
    },
    exportReadAuthority: () => null,
    invalidateContinuity: () => undefined,
    clearReadAuthority: () => undefined,
    resolve: () => {
      calls.resolve += 1;
    },
    status: () => {
      calls.status += 1;
      return allowed;
    },
  } as unknown as OfflineCommandRuntime;
  const cache = {
    resume: () => null,
    clear: () => undefined,
    bind: () => {
      calls.cacheBind += 1;
    },
    put: async () => {
      calls.cachePut += 1;
    },
  } as unknown as OfflineReadCache;
  const service = createOfflineDesktopService(online, offline, cache, {
    recoveryReadOnly: true,
  });

  assert.equal(resultOk(await service.auth.login({})), true);
  assert.equal(resultOk(await service.auth.refresh()), true);
  assert.equal(resultOk(await service.query.execute({})), true);
  assert.equal(resultOk(await service.photo.read({})), true);
  assert.equal(resultOk(await service.offline.status()), true);
  assert.equal(resultOk(await service.offline.resume()), true);

  const blocked = await Promise.all([
    service.command.execute({}),
    service.auth.pinChallenge({}),
    service.auth.pinVerify({}),
    service.photo.upload({}),
    service.photo.delete({}),
    service.offline.resolve({
      queue_id: "3a2eed00-a6c3-493c-a3a7-20bf94b1d678",
      action: "retry",
    }),
    service.offline.resolve({
      queue_id: "3a2eed00-a6c3-493c-a3a7-20bf94b1d678",
      action: "discard",
      reason: "recovery mode must not mutate the conflict queue",
      confirm: "DISCARD",
    }),
  ]);
  assert.ok(blocked.every((result) => !resultOk(result)));
  assert.equal(resultOk(await service.auth.logout()), true);
  assert.equal(resultOk(await service.command.execute({})), false);

  assert.deepEqual(calls, {
    login: 1,
    refresh: 2,
    logout: 1,
    command: 0,
    query: 1,
    pinChallenge: 0,
    pinVerify: 0,
    photoUpload: 0,
    photoRead: 1,
    photoDelete: 0,
    refreshAuthority: 0,
    replay: 0,
    queue: 0,
    resolve: 0,
    status: 1,
    health: 0,
    cacheBind: 0,
    cachePut: 0,
  });
});

type ResumeFixtureOptions = Readonly<{
  refreshOk: boolean;
  healthOk: boolean;
  hasCache: boolean;
  refreshErrorCode?: "AUTHENTICATION_FAILED" | "RESOURCE_UNAVAILABLE";
}>;

function resumeFixture(options: ResumeFixtureOptions) {
  let cacheResumeCalls = 0;
  let cacheGetCalls = 0;
  let cacheClearCalls = 0;
  let invalidations = 0;
  let healthOk = options.healthOk;
  let queryResult = serverUnavailable;
  const online = {
    auth: {
      login: async () => serverUnavailable,
      refresh: async () =>
        options.refreshOk
          ? { ok: true as const, data: resumedSession }
          : DesktopCommandExecuteResultSchema.parse({
              ok: false,
              error: createCommandError(options.refreshErrorCode ?? "RESOURCE_UNAVAILABLE"),
            }),
      pinChallenge: async () => serverUnavailable,
      pinVerify: async () => serverUnavailable,
      logout: async () => ({ ok: true, data: { logged_out: true } }),
    },
    command: { execute: async () => serverUnavailable },
    query: { execute: async () => queryResult },
    photo: {
      upload: async () => serverUnavailable,
      read: async () => serverUnavailable,
      delete: async () => serverUnavailable,
    },
    health: {
      get: async () =>
        DesktopHealthGetResultSchema.parse(
          healthOk
            ? { ok: true, data: { status: "ready" } }
            : { ok: false, error: createCommandError("RESOURCE_UNAVAILABLE") },
        ),
    },
    edge: {
      authority: async () => serverUnavailable,
      replay: async () => serverUnavailable,
    },
  } as unknown as DesktopHttpTransport;
  const offline = {
    refreshAuthority: async () => false,
    replay: async () => undefined,
    exportReadAuthority: () => null,
    invalidateContinuity: () => {
      invalidations += 1;
    },
    clearReadAuthority: () => undefined,
    status: () => serverUnavailable,
  } as unknown as OfflineCommandRuntime;
  const cache = {
    resume: () => {
      cacheResumeCalls += 1;
      return options.hasCache
        ? {
            sessionView: resumedSession,
            cachedQueryCount: 2,
            grantNotAfter: "2026-07-30T12:00:00.000Z",
          }
        : null;
    },
    get: async () => {
      cacheGetCalls += 1;
      return queued;
    },
    clear: () => {
      cacheClearCalls += 1;
    },
  } as unknown as OfflineReadCache;
  return Object.freeze({
    service: createOfflineDesktopService(online, offline, cache),
    cacheResumeCalls: () => cacheResumeCalls,
    cacheGetCalls: () => cacheGetCalls,
    cacheClearCalls: () => cacheClearCalls,
    invalidations: () => invalidations,
    setHealthOk: (value: boolean) => {
      healthOk = value;
    },
    setQueryError: (code: "AUTHENTICATION_FAILED" | "RESOURCE_UNAVAILABLE") => {
      queryResult = DesktopCommandExecuteResultSchema.parse({
        ok: false,
        error: createCommandError(code),
      });
    },
  });
}

test("offline.resume always prefers a successful online refresh over cached state", async () => {
  const fixture = resumeFixture({ refreshOk: true, healthOk: true, hasCache: true });
  const result = await fixture.service.offline.resume();
  assert.equal(
    (result as Readonly<{ ok: boolean; data?: Readonly<{ mode?: string }> }>).data?.mode,
    "online",
  );
  assert.equal(fixture.cacheResumeCalls(), 0);
});

test("offline.resume refuses cached state when the server is healthy but authorization is revoked", async () => {
  const fixture = resumeFixture({
    refreshOk: false,
    healthOk: true,
    hasCache: true,
    refreshErrorCode: "AUTHENTICATION_FAILED",
  });
  const result = await fixture.service.offline.resume();
  assert.equal(
    (result as Readonly<{ ok: boolean; error?: Readonly<{ code?: string }> }>).error?.code,
    "AUTHENTICATION_FAILED",
  );
  assert.equal(fixture.cacheResumeCalls(), 0);
  assert.equal(fixture.cacheClearCalls(), 1);
});

test("disconnected cold start restores a token-free read-only session and exact cached queries", async () => {
  const fixture = resumeFixture({ refreshOk: false, healthOk: false, hasCache: true });
  const resumed = await fixture.service.offline.resume();
  assert.equal(
    (resumed as Readonly<{ ok: boolean; data?: Readonly<{ mode?: string }> }>).data?.mode,
    "offline_read_only",
  );
  assert.doesNotMatch(
    JSON.stringify(resumed),
    /access_token|refresh_token|authorization|cookie|password|pin|secret/iu,
  );
  assert.equal(fixture.invalidations(), 1);
  assert.equal(
    ((await fixture.service.command.execute({})) as Readonly<{ ok: boolean }>).ok,
    false,
  );
  assert.deepEqual(await fixture.service.query.execute({ name: "order.list", body: {} }), queued);
  assert.equal(fixture.cacheGetCalls(), 1);
  assert.deepEqual(await fixture.service.health.get(), {
    ok: true,
    data: { status: "ready" },
  });

  await fixture.service.auth.logout();
  assert.equal(fixture.cacheClearCalls(), 1);
});

test("query fallback is never consulted while the service health boundary is reachable", async () => {
  const fixture = resumeFixture({ refreshOk: false, healthOk: true, hasCache: true });
  assert.deepEqual(
    await fixture.service.query.execute({ name: "order.list", body: {} }),
    serverUnavailable,
  );
  assert.equal(fixture.cacheGetCalls(), 0);
});

test("a resumed read-only session is discarded after an explicit query rejection", async () => {
  const fixture = resumeFixture({ refreshOk: false, healthOk: false, hasCache: true });
  await fixture.service.offline.resume();
  fixture.setQueryError("AUTHENTICATION_FAILED");

  const rejected = await fixture.service.query.execute({ name: "order.list", body: {} });
  assert.equal(
    (rejected as Readonly<{ ok: boolean; error?: Readonly<{ code?: string }> }>).error?.code,
    "AUTHENTICATION_FAILED",
  );
  assert.equal(fixture.cacheClearCalls(), 1);
  assert.equal(fixture.cacheGetCalls(), 0);

  fixture.setQueryError("RESOURCE_UNAVAILABLE");
  await fixture.service.query.execute({ name: "order.list", body: {} });
  assert.equal(fixture.cacheGetCalls(), 0);
});

test("a resumed read-only session is discarded when health recovers after query failure", async () => {
  const fixture = resumeFixture({ refreshOk: false, healthOk: false, hasCache: true });
  await fixture.service.offline.resume();
  fixture.setHealthOk(true);

  assert.deepEqual(
    await fixture.service.query.execute({ name: "order.list", body: {} }),
    serverUnavailable,
  );
  assert.equal(fixture.cacheClearCalls(), 1);
  assert.equal(fixture.cacheGetCalls(), 0);

  fixture.setHealthOk(false);
  await fixture.service.query.execute({ name: "order.list", body: {} });
  assert.equal(fixture.cacheGetCalls(), 0);
});

test("logout during authority maintenance cannot resurrect a stale session cache", async () => {
  let releaseRefresh: (() => void) | undefined;
  let refreshStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  let bindCalls = 0;
  let replayCalls = 0;
  let clearAuthorityCalls = 0;
  const online = {
    auth: {
      login: async () => ({
        ok: true,
        data: { session_view: resumedSession, staff_directory: [] },
      }),
      refresh: async () => serverUnavailable,
      pinChallenge: async () => serverUnavailable,
      pinVerify: async () => serverUnavailable,
      logout: async () => ({ ok: true, data: { logged_out: true } }),
    },
    command: { execute: async () => serverUnavailable },
    query: { execute: async () => serverUnavailable },
    photo: {
      upload: async () => serverUnavailable,
      read: async () => serverUnavailable,
      delete: async () => serverUnavailable,
    },
    health: { get: async () => serverUnavailable },
    edge: {
      authority: async () => serverUnavailable,
      replay: async () => serverUnavailable,
    },
  } as unknown as DesktopHttpTransport;
  const offline = {
    refreshAuthority: async () => {
      refreshStarted?.();
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      return true;
    },
    replay: async () => {
      replayCalls += 1;
    },
    exportReadAuthority: () => ({ serverPublicKeySpki: "unused", offlineGrant: {} }),
    invalidateContinuity: () => undefined,
    clearReadAuthority: () => {
      clearAuthorityCalls += 1;
    },
  } as unknown as OfflineCommandRuntime;
  const cache = {
    bind: () => {
      bindCalls += 1;
    },
    clear: () => undefined,
  } as unknown as OfflineReadCache;
  const service = createOfflineDesktopService(online, offline, cache);

  const login = service.auth.login({});
  await started;
  await service.auth.logout();
  releaseRefresh?.();
  await login;

  assert.equal(bindCalls, 0);
  assert.equal(replayCalls, 0);
  assert.ok(clearAuthorityCalls >= 2);
});
