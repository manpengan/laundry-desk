import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeUpdateStateStore } from "./runtime-state.js";
import { prepareVerifiedStartup } from "./verified-startup.js";
import { initializeWindowsBaseline, verifyWindowsBaseline } from "./windows-update-baseline.js";

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-verified-startup-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = join(root, "installed", "Counter.exe");
  const current = join(root, "updated", "Counter.exe");
  await mkdir(join(root, "installed", "resources"), { recursive: true });
  await writeFile(original, "signed synthetic exe");
  await writeFile(join(root, "installed", "resources", "app.asar"), "trusted initial application");
  const state = new RuntimeUpdateStateStore(join(root, "updates"), {
    currentVersion: "0.1.0",
    currentAppPath: original,
    minimumSecureVersion: "0.1.0",
  });
  await initializeWindowsBaseline(state.root, original, true);
  const nonce = "12345678-1234-4234-9234-123456789012";
  state.activate({
    slot: "B",
    version: "0.2.0",
    appPath: current,
    artifactSha256: "a".repeat(64),
    nonce,
    now: new Date().toISOString(),
    minimumSecureVersion: "0.1.0",
  });
  state.confirmActivation("B", nonce, new Date().toISOString());
  return { root, original, current, state };
}

test("corrupt confirmed slot falls back once and validates the current original installation before continuing", async (t) => {
  const f = await setup(t);
  const checked: string[] = [];
  const validate = async (path: string) => {
    checked.push(path);
    if (path === f.current) throw new Error("corrupt ZIP");
    await verifyWindowsBaseline(f.state.root, path);
  };
  const startup = await prepareVerifiedStartup(f.state, f.original, null, validate);
  assert.equal(startup.action, "continue");
  assert.deepEqual(checked, [f.current, f.original]);
  assert.equal(f.state.snapshot().active_slot, "A");
  assert.equal(f.state.snapshot().slots.B.healthy, false);
  await prepareVerifiedStartup(f.state, f.original, null, validate);
  assert.deepEqual(checked, [f.current, f.original, f.original]);
});

test("tampered original ASAR prevents rollback and repeated startup stays in recovery", async (t) => {
  const f = await setup(t);
  await writeFile(
    join(f.root, "installed", "resources", "app.asar"),
    "tampered initial application",
  );
  const validate = async (path: string) => {
    if (path === f.current) throw new Error("corrupt ZIP");
    await verifyWindowsBaseline(f.state.root, path);
  };
  assert.equal(
    (await prepareVerifiedStartup(f.state, f.original, null, validate)).action,
    "recovery",
  );
  assert.equal(
    (await prepareVerifiedStartup(f.state, f.original, null, validate)).action,
    "recovery",
  );
  assert.equal(f.state.snapshot().slots.A.healthy, false);
  assert.equal(f.state.snapshot().slots.B.healthy, false);
});

test("corrupt active slot never falls back below the persisted security floor", async (t) => {
  const f = await setup(t);
  f.state.raiseSecurityFloor("0.2.0", new Date().toISOString());
  const seen: string[] = [];
  const result = await prepareVerifiedStartup(f.state, f.original, null, async (path) => {
    seen.push(path);
    throw new Error("bad");
  });
  assert.equal(result.action, "recovery");
  assert.deepEqual(seen, [f.current]);
});
