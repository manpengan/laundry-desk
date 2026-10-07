import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopCommandExecuteResultSchema,
  DesktopSessionViewSchema,
  createCommandError,
  type DesktopSessionView,
} from "@laundry/contracts";

import type { DesktopHttpTransport } from "../desktop/http-transport.js";
import type { OfflineReadCache } from "./read-cache.js";
import type { OfflineCommandRuntime } from "./runtime.js";
import { session as originalSession } from "./runtime-test-fixtures.js";
import { createOfflineDesktopService } from "./service.js";

const unavailable = Object.freeze({
  ok: false as const,
  error: createCommandError("RESOURCE_UNAVAILABLE"),
});
const answer = DesktopCommandExecuteResultSchema.parse({
  ok: true,
  data: { execution: "executed", result: { marker: "original-command" } },
});
const input = Object.freeze({
  name: "customer.upsert",
  body: { phone: "13800000000", name: "Synthetic" },
});
function deferred() {
  let release = () => undefined as void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

type Stage = "command" | "health" | "queue" | "maintenance";
function fixture() {
  let pausedStage: Stage | null = null;
  let remoteAvailable = false;
  let runtimeSession: DesktopSessionView | null = null;
  const started = deferred(),
    gate = deferred(),
    transitioned = deferred();
  const queuedBy: Array<DesktopSessionView | null> = [];
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
      logout: async () => ({ ok: true, data: { logged_out: true } }),
    },
    command: {
      execute: async () => {
        await pause("command");
        return remoteAvailable ? answer : unavailable;
      },
    },
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
    exportReadAuthority: () => null,
    reconcileSession: (session: DesktopSessionView | null) => {
      runtimeSession = session;
      if (session !== originalSession) transitioned.release();
    },
    invalidateContinuity: () => undefined,
    clearReadAuthority: () => undefined,
    queueCommand: async () => {
      queuedBy.push(runtimeSession);
      await pause("queue");
      return answer;
    },
  } as unknown as OfflineCommandRuntime;
  const service = createOfflineDesktopService(online, runtime, {
    clear: () => undefined,
  } as unknown as OfflineReadCache);
  return {
    service,
    queuedBy,
    started: started.promise,
    release: gate.release,
    pauseAt: (stage: Stage) => {
      pausedStage = stage;
      remoteAvailable = stage === "maintenance";
    },
    transition: async (transition: "switch-staff" | "logout" | "new-session") => {
      if (transition === "logout") return service.auth.logout();
      const next = DesktopSessionViewSchema.parse({
        ...originalSession,
        session: {
          ...originalSession.session,
          session_id: "10000000-0000-4000-8000-000000000006",
          staff_id:
            transition === "switch-staff"
              ? "10000000-0000-4000-8000-000000000007"
              : originalSession.session.staff_id,
        },
      });
      const pending = service.auth.login(next);
      await transitioned.promise;
      return { pending };
    },
  };
}

for (const stage of ["command", "health", "queue", "maintenance"] as const) {
  for (const transition of ["switch-staff", "logout", "new-session"] as const) {
    test(`an old command cannot cross ${transition} while awaiting ${stage}`, async () => {
      const f = fixture();
      await f.service.auth.login(originalSession);
      f.pauseAt(stage);
      const pending = f.service.command.execute(input);
      await f.started;
      const changed = await f.transition(transition);
      f.release();
      const result = await pending;
      if (changed && typeof changed === "object" && "pending" in changed) await changed.pending;
      assert.ok(
        f.queuedBy.every((session) => session === originalSession),
        "old intent must never enter a replacement session queue",
      );
      if (stage !== "queue") assert.deepEqual(f.queuedBy, []);
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

test("an unchanged session still queues an offline command exactly once", async () => {
  const f = fixture();
  await f.service.auth.login(originalSession);
  assert.deepEqual(await f.service.command.execute(input), answer);
  assert.deepEqual(f.queuedBy, [originalSession]);
});

test("an identified receive with a lost server response is never queued again", async () => {
  const f = fixture();
  await f.service.auth.login(originalSession);
  assert.deepEqual(
    await f.service.command.execute({ name: "order.receive", operation_id: "synthetic-operation" }),
    unavailable,
  );
  assert.deepEqual(f.queuedBy, []);
});
