import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopCommandExecuteResultSchema,
  DesktopHealthGetResultSchema,
  createCommandError,
} from "@laundry/contracts";

import type { DesktopHttpTransport } from "../desktop/http-transport.js";
import type { OfflineCommandRuntime } from "./runtime.js";
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

function serviceFixture(healthOk: boolean) {
  let queueCalls = 0;
  const online = {
    auth: {
      login: async () => serverUnavailable,
      refresh: async () => serverUnavailable,
      pinChallenge: async () => serverUnavailable,
      pinVerify: async () => serverUnavailable,
      logout: async () => serverUnavailable,
    },
    command: { execute: async () => serverUnavailable },
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
  } as unknown as OfflineCommandRuntime;
  return Object.freeze({
    service: createOfflineDesktopService(online, offline),
    queueCalls: () => queueCalls,
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
