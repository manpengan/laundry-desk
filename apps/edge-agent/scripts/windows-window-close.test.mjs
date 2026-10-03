import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { closeWindowAndWaitForApplication } from "../e2e/windows-window-close.mjs";

const destroyed = new Error(
  "electronApplication.evaluate: Execution context was destroyed, most likely because of a navigation.",
);

test("a close RPC may fail before the mandatory application close event", async () => {
  const application = new EventEmitter();
  let settled = false;
  const closed = closeWindowAndWaitForApplication(application, async () => {
    assert.equal(application.listenerCount("close"), 1);
    throw destroyed;
  });
  const observed = closed.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  application.emit("close");
  await observed;
  assert.equal(application.listenerCount("close"), 0);
});

test("normal RPC acknowledgement still waits for the close event", async () => {
  const application = new EventEmitter();
  let settled = false;
  const closed = closeWindowAndWaitForApplication(application, async () => undefined);
  const observed = closed.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  application.emit("close");
  await observed;
  assert.equal(application.listenerCount("close"), 0);
});

test("an unrelated RPC failure is preserved even when the application closes", async () => {
  const application = new EventEmitter();
  const failure = new Error("WINDOWS_MAIN_WINDOW_UNAVAILABLE");
  await assert.rejects(
    closeWindowAndWaitForApplication(application, async () => {
      application.emit("close");
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(application.listenerCount("close"), 0);
});

for (const [name, request] of [
  ["acknowledged", async () => undefined],
  [
    "context terminated",
    async () => {
      throw destroyed;
    },
  ],
]) {
  test(`${name} RPC without close fails at the bounded deadline`, async () => {
    const application = new EventEmitter();
    await assert.rejects(closeWindowAndWaitForApplication(application, request, 10), {
      message: "WINDOWS_WINDOW_CLOSE_TIMEOUT",
    });
    assert.equal(application.listenerCount("close"), 0);
  });
}

test("a close event does not hide an RPC that never finishes", async () => {
  const application = new EventEmitter();
  await assert.rejects(
    closeWindowAndWaitForApplication(
      application,
      () => {
        application.emit("close");
        return new Promise(() => {});
      },
      10,
    ),
    { message: "WINDOWS_WINDOW_CLOSE_TIMEOUT" },
  );
  assert.equal(application.listenerCount("close"), 0);
});

test("only the close RPC's exact termination messages are accepted", async () => {
  for (const failure of [
    new Error(
      "page.evaluate: Execution context was destroyed, most likely because of a navigation.",
    ),
    new Error("unrelated failure: Target page, context or browser has been closed"),
    "electronApplication.evaluate: Target page, context or browser has been closed",
  ]) {
    const application = new EventEmitter();
    await assert.rejects(
      closeWindowAndWaitForApplication(application, async () => {
        application.emit("close");
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(application.listenerCount("close"), 0);
  }
});
