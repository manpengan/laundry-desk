import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SignedPrintRuntime } from "./runtime.js";
import { ConfiguredPrinterRuntime, PrinterManagerError } from "./configured-runtime.js";
import { PrinterConfigStore } from "./printer-config.js";
import type { MacPrinterPilotResult } from "./mac-printer-pilot.js";

type RuntimeEvent = Readonly<{ action: "start" | "stop"; queue: string }>;

async function fixture(t: test.TestContext, installed = ["XP58_A", "XP58_B"]) {
  const root = await mkdtemp(join(tmpdir(), "laundry-configured-printer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events: RuntimeEvent[] = [];
  const pilotCalls: Readonly<{ mode: string; queue?: string }>[] = [];
  const pilot = async (
    input: Readonly<{ mode: "discover" | "validate" | "print"; queue?: string }>,
  ) => {
    pilotCalls.push(
      Object.freeze({
        mode: input.mode,
        ...(input.queue === undefined ? {} : { queue: input.queue }),
      }),
    );
    if (input.mode === "discover") {
      return Object.freeze({
        ok: true,
        mode: "discover" as const,
        queues: Object.freeze([...installed]),
        message: "discovered",
      });
    }
    const queue = input.queue ?? "";
    if (!installed.includes(queue)) {
      return Object.freeze({
        ok: false,
        mode: input.mode,
        queues: Object.freeze([...installed]),
        message: "missing",
      });
    }
    if (input.mode === "validate") {
      return Object.freeze({
        ok: true,
        mode: "validate" as const,
        queues: Object.freeze([...installed]),
        selected_queue: queue,
        message: "validated",
      });
    }
    return Object.freeze({
      ok: true,
      mode: "print" as const,
      queues: Object.freeze([...installed]),
      selected_queue: queue,
      cups_job_id: `${queue}-42`,
      payload_sha256: "a".repeat(64),
      bytes_written: 64,
      message: "submitted",
    });
  };
  const manager = new ConfiguredPrinterRuntime({
    store: await PrinterConfigStore.open(join(root, "printing")),
    pilot: (input) => pilot(input) as Promise<MacPrinterPilotResult>,
    runtimeEnabled: true,
    createRuntime: async (queue) =>
      ({
        controller: {
          start: async () => {
            events.push(Object.freeze({ action: "start", queue }));
          },
          stop: async () => {
            events.push(Object.freeze({ action: "stop", queue }));
          },
        },
        continuity: { invalidate: () => undefined },
      }) as unknown as SignedPrintRuntime,
  });
  return Object.freeze({ manager, events, pilotCalls, root });
}

test("configured runtime bootstraps env once and serially restarts queue selection", async (t) => {
  const { manager, events, root } = await fixture(t);
  const initial = await manager.initialize(" XP58_A ");
  assert.equal(initial.state, "ready");
  assert.equal(initial.configured_queue, "XP58_A");

  const switched = await manager.configure("XP58_B");
  assert.equal(switched.state, "ready");
  assert.deepEqual(events, [
    { action: "start", queue: "XP58_A" },
    { action: "stop", queue: "XP58_A" },
    { action: "start", queue: "XP58_B" },
  ]);

  const restarted = new ConfiguredPrinterRuntime({
    store: await PrinterConfigStore.open(join(root, "printing")),
    pilot: async (input) =>
      Object.freeze({
        ok: true,
        mode: input.mode,
        queues: Object.freeze(["XP58_B"]),
        ...(input.mode === "discover" ? {} : { selected_queue: "XP58_B" }),
        message: "ok",
      }) as MacPrinterPilotResult,
    runtimeEnabled: false,
    createRuntime: async () => {
      throw new Error("runtime must stay disabled");
    },
  });
  const persisted = await restarted.initialize("IGNORED_ENV");
  assert.equal(persisted.configured_queue, "XP58_B");
});

test("configured runtime keeps active queue when a replacement is not installed", async (t) => {
  const { manager, events } = await fixture(t, ["XP58_A"]);
  await manager.initialize("XP58_A");

  await assert.rejects(
    () => manager.configure("XP58_MISSING"),
    (error: unknown) => error instanceof PrinterManagerError && error.code === "QUEUE_NOT_FOUND",
  );
  assert.deepEqual(events, [{ action: "start", queue: "XP58_A" }]);
  assert.equal((await manager.status()).configured_queue, "XP58_A");
});

test("configured runtime submits only the pilot fixed ticket to its configured queue", async (t) => {
  const { manager, pilotCalls } = await fixture(t, ["XP58_A"]);
  await manager.initialize("XP58_A");
  const result = await manager.test();

  assert.equal(result.queue, "XP58_A");
  assert.equal(result.cups_job_id, "XP58_A-42");
  assert.equal(result.payload_sha256, "a".repeat(64));
  assert.deepEqual(pilotCalls.at(-1), { mode: "print", queue: "XP58_A" });
});

test("invalid legacy env bootstrap fails closed without blocking Settings recovery", async (t) => {
  const { manager, events } = await fixture(t, ["XP58_A"]);
  const status = await manager.initialize("../raw-device");

  assert.equal(status.state, "disabled");
  assert.equal(status.configured_queue, null);
  assert.match(status.message, /未启用/u);
  assert.deepEqual(events, []);

  const recovered = await manager.configure("XP58_A");
  assert.equal(recovered.state, "ready");
  assert.deepEqual(events, [{ action: "start", queue: "XP58_A" }]);
});
