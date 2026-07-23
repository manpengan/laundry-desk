import assert from "node:assert/strict";
import test from "node:test";

import { createExecutionGate } from "./execution-gate.js";

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("runs operations one at a time in FIFO order", { timeout: 2_000 }, async () => {
  const gate = createExecutionGate();
  const releases = [deferred(), deferred(), deferred()];
  const started = [deferred(), deferred(), deferred()];
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;

  const jobs = releases.map((release, index) =>
    gate(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`start:${index}`);
      started[index]!.resolve();
      await release.promise;
      events.push(`finish:${index}`);
      active -= 1;
      return index;
    }),
  );

  await started[0]!.promise;
  assert.deepEqual(events, ["start:0"]);

  releases[0]!.resolve();
  await started[1]!.promise;
  assert.deepEqual(events, ["start:0", "finish:0", "start:1"]);

  releases[1]!.resolve();
  await started[2]!.promise;
  assert.deepEqual(events, ["start:0", "finish:0", "start:1", "finish:1", "start:2"]);

  releases[2]!.resolve();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2]);
  assert.equal(maxActive, 1);
  assert.deepEqual(events, ["start:0", "finish:0", "start:1", "finish:1", "start:2", "finish:2"]);
});

test("continues with the second operation after the first rejects", async () => {
  const gate = createExecutionGate();
  const events: string[] = [];

  const first = gate(async () => {
    events.push("first");
    throw new Error("first failed");
  });
  const second = gate(async () => {
    events.push("second");
    return "second result";
  });

  await assert.rejects(first, /first failed/);
  assert.equal(await second, "second result");
  assert.deepEqual(events, ["first", "second"]);
});
