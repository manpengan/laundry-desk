import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { executeDataChild } from "../runtime-kit/no-repo-data-helpers.mjs";

const fakeChild = (onKill = () => undefined) => {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => undefined;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    onKill(child, signal);
    return true;
  };
  return Object.freeze({ child, signals });
};

const assertClean = ({ child }) => {
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
};

test(
  "data acceptance child completes normally and clears its timeout",
  { timeout: 1_000 },
  async () => {
    let current;
    const result = await executeDataChild(
      "/fake/runtime",
      ["maintenance"],
      { input: "", timeoutMs: 20 },
      {
        graceMs: 10,
        spawn: () => {
          current = fakeChild();
          queueMicrotask(() => {
            current.child.stdout.emit("data", Buffer.from('{"status":"ready"}'));
            current.child.emit("close", 0);
          });
          return current.child;
        },
      },
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '{"status":"ready"}');
    assert.deepEqual(current.signals, []);
    assertClean(current);
  },
);

test(
  "data acceptance timeout accepts a child that exits after TERM",
  { timeout: 1_000 },
  async () => {
    let current;
    await assert.rejects(
      executeDataChild(
        "/fake/runtime",
        [],
        { timeoutMs: 5 },
        {
          graceMs: 10,
          spawn: () => {
            current = fakeChild((child, signal) => {
              if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", null, signal));
            });
            return current.child;
          },
        },
      ),
      { message: "RUNTIME_DATA_CHILD_TIMEOUT" },
    );
    assert.deepEqual(current.signals, ["SIGTERM"]);
    assertClean(current);
  },
);

test(
  "data acceptance timeout escalates a stubborn child and waits for close",
  { timeout: 1_000 },
  async () => {
    let current;
    let killed = false;
    await assert.rejects(
      executeDataChild(
        "/fake/runtime",
        [],
        { timeoutMs: 5 },
        {
          graceMs: 10,
          spawn: () => {
            current = fakeChild((child, signal) => {
              if (signal === "SIGKILL") {
                killed = true;
                queueMicrotask(() => child.emit("close", null, signal));
              }
            });
            return current.child;
          },
        },
      ),
      { message: "RUNTIME_DATA_CHILD_TIMEOUT" },
    );
    assert.equal(killed, true);
    assert.deepEqual(current.signals, ["SIGTERM", "SIGKILL"]);
    assertClean(current);
  },
);
