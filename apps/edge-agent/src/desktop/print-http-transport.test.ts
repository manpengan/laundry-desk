import assert from "node:assert/strict";
import test from "node:test";

import { DesktopSessionViewSchema, PrintDispatchClaimResponseSchema } from "@laundry/contracts";

import {
  RESOURCE_FAILURE,
  type DesktopFailure,
  type ResultEnvelope,
} from "./http-transport-support.js";
import {
  createEdgePrintHttpTransport,
  type PrintProtectedExecutor,
} from "./print-http-transport.js";

const SESSION = DesktopSessionViewSchema.parse({
  session: {
    session_id: "00000000-0000-4000-8000-000000000001",
    session_version: 1,
    org_id: "00000000-0000-4000-8000-000000000002",
    store_id: "00000000-0000-4000-8000-000000000003",
    staff_id: "00000000-0000-4000-8000-000000000004",
    device_id: "00000000-0000-4000-8000-000000000005",
    permission_version: 1,
  },
  role: "admin",
  features: {},
  display: { store_name: "Store", staff_name: "Admin", org_code: "org", store_code: "store" },
});

test("print claim uses the fixed protected route/body and captures both clocks", async () => {
  let observedPath = "";
  let observedBody: Readonly<Record<string, unknown>> | Uint8Array = Object.freeze({});
  const executeProtected: PrintProtectedExecutor = async <T extends ResultEnvelope>(
    schema: Readonly<{
      safeParseAsync: (
        input: unknown,
      ) => Promise<Readonly<{ success: true; data: T }> | Readonly<{ success: false }>>;
    }>,
    path: string,
    body: Readonly<Record<string, unknown>> | Uint8Array,
  ): Promise<T | DesktopFailure> => {
    observedPath = path;
    observedBody = body;
    const parsed = await schema.safeParseAsync({ ok: true, data: null });
    return parsed.success ? parsed.data : RESOURCE_FAILURE;
  };
  const monotonic = [10, 18];
  const transport = createEdgePrintHttpTransport({
    executeProtected,
    currentSession: () => SESSION,
    wallNowMs: () => 1_000,
    monotonicNowMs: () => monotonic.shift() ?? 18,
  });

  const outcome = await transport.claim();

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(observedPath, "/api/v2/edge/print/claim");
  assert.deepEqual(observedBody, { supported_printer_kinds: ["xp58"] });
  assert.deepEqual(outcome.timing, {
    requestStartedWallMs: 1_000,
    requestStartedMonoMs: 10,
    responseReceivedMonoMs: 18,
  });
  assert.equal(
    PrintDispatchClaimResponseSchema.safeParse({ ok: true, data: outcome.data }).success,
    true,
  );
});

test("claim rejects session or permission generation changes during the request", async (t) => {
  for (const [name, changed] of [
    ["session version", { session_version: 2 }],
    ["permission version", { permission_version: 2 }],
  ] as const) {
    await t.test(name, async () => {
      let current = SESSION;
      const rotated = DesktopSessionViewSchema.parse({
        ...SESSION,
        session: { ...SESSION.session, ...changed },
      });
      const executeProtected: PrintProtectedExecutor = async <T extends ResultEnvelope>(
        schema: Readonly<{
          safeParseAsync: (
            input: unknown,
          ) => Promise<Readonly<{ success: true; data: T }> | Readonly<{ success: false }>>;
        }>,
      ): Promise<T | DesktopFailure> => {
        current = rotated;
        const parsed = await schema.safeParseAsync({ ok: true, data: null });
        return parsed.success ? parsed.data : RESOURCE_FAILURE;
      };
      const transport = createEdgePrintHttpTransport({
        executeProtected,
        currentSession: () => current,
        wallNowMs: () => 1_000,
        monotonicNowMs: () => 10,
      });

      assert.deepEqual(await transport.claim(), RESOURCE_FAILURE);
    });
  }
});
