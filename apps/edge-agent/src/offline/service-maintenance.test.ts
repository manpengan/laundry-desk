import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopHttpTransport } from "../desktop/http-transport.js";
import type { OfflineCommandRuntime } from "./runtime.js";
import type { OfflineReadCache } from "./read-cache.js";
import { createOfflineDesktopService } from "./service.js";

test("the desktop service hands maintenance to the main-process operation, even read-only", async () => {
  const calls: unknown[] = [];
  const answer = Object.freeze({ ok: true, data: { status: "maintenance_opened" } });
  const online = {
    maintenance: {
      execute: async (input: unknown) => {
        calls.push(input);
        return answer;
      },
    },
  } as unknown as DesktopHttpTransport;
  const cache = { resume: () => null, clear: () => undefined } as unknown as OfflineReadCache;
  const service = createOfflineDesktopService(online, {} as OfflineCommandRuntime, cache, {
    recoveryReadOnly: true,
  });
  assert.ok(service.maintenance, "the IPC handler finds no maintenance operation");
  const input = { operation: "open", intent: "maintenance" };
  assert.equal(await service.maintenance.execute(input), answer);
  assert.deepEqual(calls, [input]);
});
