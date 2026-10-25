import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  maintenanceResponse,
  MAINTENANCE_HEALTH_TIMEOUT_MS,
  MAINTENANCE_OPEN_TIMEOUT_MS,
} from "./windows-response.js";

function childFixture() {
  const events = new EventEmitter();
  const state = { killed: 0, detached: 0 };
  const child = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    on: events.on.bind(events),
    once: events.once.bind(events),
    kill: () => state.killed++,
    unref: () => state.detached++,
  };
  return { child, events, state };
}

test("verified backup health can finish beyond the GUI startup budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = childFixture();
  const pending = maintenanceResponse(fixture.child, "health", () => true);
  // This is the successful same-source Windows CI measurement, not an arbitrary sleep.
  t.mock.timers.tick(36_391);
  assert.equal(fixture.state.killed, 0);
  fixture.child.stdout.write('{"status":"backup_health"}\n');
  fixture.events.emit("close", 0);
  assert.deepEqual(await pending, { status: "backup_health" });
  t.mock.timers.tick(MAINTENANCE_HEALTH_TIMEOUT_MS);
  assert.equal(fixture.state.killed, 0);
});

test("health retains a finite deadline and cannot resolve after timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = childFixture();
  const pending = maintenanceResponse(fixture.child, "health", () => true);
  const rejected = assert.rejects(pending, /MAINTENANCE_TIMEOUT/u);
  t.mock.timers.tick(MAINTENANCE_HEALTH_TIMEOUT_MS - 1);
  assert.equal(fixture.state.killed, 0);
  t.mock.timers.tick(1);
  await rejected;
  fixture.child.stdout.write('{"status":"backup_health"}\n');
  fixture.events.emit("close", 0);
  assert.equal(fixture.state.killed, 1);
});

for (const operation of ["open", "handoff"] as const) {
  test(`${operation} keeps the shorter GUI startup deadline`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = childFixture();
    const rejected = assert.rejects(
      maintenanceResponse(fixture.child, operation, () => true),
      /MAINTENANCE_TIMEOUT/u,
    );
    t.mock.timers.tick(MAINTENANCE_OPEN_TIMEOUT_MS);
    await rejected;
    assert.equal(fixture.state.killed, 1);
  });
}

test("health still waits for successful exit and rechecks current authorization", async () => {
  const fixture = childFixture();
  let authorized = true;
  const pending = maintenanceResponse(fixture.child, "health", () => authorized);
  fixture.child.stdout.write('{"status":"backup_health"}\n');
  authorized = false;
  const rejected = assert.rejects(pending, /MAINTENANCE_START_FAILED/u);
  fixture.events.emit("close", 0);
  await rejected;
  assert.equal(fixture.state.killed, 1);
  assert.equal(fixture.state.detached, 0);
});

test("GUI acknowledgement detaches and ignores a later child close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = childFixture();
  const pending = maintenanceResponse(fixture.child, "open", () => true);
  fixture.child.stdout.write('{"status":"maintenance_opened"}\n');
  assert.deepEqual(await pending, { status: "maintenance_opened" });
  fixture.events.emit("close", 1);
  t.mock.timers.tick(MAINTENANCE_OPEN_TIMEOUT_MS);
  assert.deepEqual(fixture.state, { killed: 0, detached: 1 });
});

test("stderr, oversized output, malformed JSON and unsuccessful exit still reject", async () => {
  const failures = [
    (fixture: ReturnType<typeof childFixture>) => fixture.child.stderr.write("failure"),
    (fixture: ReturnType<typeof childFixture>) => fixture.child.stdout.write("x".repeat(32769)),
    (fixture: ReturnType<typeof childFixture>) => {
      fixture.child.stdout.write("invalid");
      fixture.events.emit("close", 0);
    },
    (fixture: ReturnType<typeof childFixture>) => fixture.events.emit("close", 1),
  ];
  for (const fail of failures) {
    const fixture = childFixture();
    const rejected = assert.rejects(
      maintenanceResponse(fixture.child, "health", () => true),
      /MAINTENANCE_START_FAILED/u,
    );
    fail(fixture);
    await rejected;
    assert.equal(fixture.state.killed, 1);
  }
});
