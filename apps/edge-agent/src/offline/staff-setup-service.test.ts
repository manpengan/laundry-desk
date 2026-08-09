import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopHttpTransport } from "../desktop/http-transport.js";
import type { OfflineReadCache } from "./read-cache.js";
import type { OfflineCommandRuntime } from "./runtime.js";
import { createOfflineDesktopService } from "./service.js";

const INPUT = Object.freeze({
  credential_setup_ref: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  password: "correct-horse-battery",
  pin: "864209",
});
const SUCCESS = Object.freeze({
  ok: true as const,
  data: Object.freeze({
    target_staff_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    permission_version: 2,
    status: "active" as const,
  }),
});

function createService(recoveryReadOnly: boolean) {
  const captured: unknown[] = [];
  const unavailable = Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: "RESOURCE_UNAVAILABLE", message: "unavailable" }),
  });
  const online = {
    auth: {
      login: async () => unavailable,
      refresh: async () => unavailable,
      pinChallenge: async () => unavailable,
      pinVerify: async () => unavailable,
      credentialComplete: async (input: unknown) => {
        captured.push(input);
        return SUCCESS;
      },
      logout: async () => unavailable,
    },
  } as unknown as DesktopHttpTransport;
  const offline = {} as unknown as OfflineCommandRuntime;
  const cache = {} as unknown as OfflineReadCache;
  return Object.freeze({
    service: createOfflineDesktopService(online, offline, cache, { recoveryReadOnly }),
    captured,
  });
}

test("credential setup is forwarded online and returns a credential-free result", async () => {
  const fixture = createService(false);
  const result = await fixture.service.auth.credentialComplete?.(INPUT);

  assert.deepEqual(result, SUCCESS);
  assert.deepEqual(fixture.captured, [INPUT]);
  assert.doesNotMatch(JSON.stringify(result), /password|pin|credential_setup_ref/iu);
});

test("credential setup fails closed in recovery read-only mode", async () => {
  const fixture = createService(true);
  const result = await fixture.service.auth.credentialComplete?.(INPUT);

  assert.equal((result as { ok?: unknown })?.ok, false);
  assert.deepEqual(fixture.captured, []);
});
