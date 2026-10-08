import assert from "node:assert/strict";
import test from "node:test";

import type { ResolvedMotion } from "../appearance.js";
import {
  runThemeTransition,
  THEME_TRANSITION_DEADLINE_MS,
  type TransitionHost,
} from "./theme-transition.js";

function harness(host: TransitionHost | null) {
  const timers: { run: () => void; ms: number }[] = [];
  let updates = 0;
  const switchTheme = (motion: ResolvedMotion) =>
    runThemeTransition(motion, () => (updates += 1), {
      host,
      schedule: (run, ms) => timers.push({ run, ms }),
      commit: (update) => update(),
    });
  return { switchTheme, timers, updates: () => updates };
}

function fakeHost(visibilityState: DocumentVisibilityState = "visible") {
  const calls: { callback: () => void; skipped: boolean }[] = [];
  const host: TransitionHost = {
    visibilityState,
    startViewTransition: (callback) => {
      const call = { callback, skipped: false };
      calls.push(call);
      return { skipTransition: () => void (call.skipped = true) };
    },
  };
  return { host, calls };
}

test("calm and off switch at once without a view transition", () => {
  const { host, calls } = fakeHost();
  const run = harness(host);
  run.switchTheme("calm");
  run.switchTheme("off");
  assert.equal(run.updates(), 2);
  assert.equal(calls.length, 0);
  assert.equal(run.timers.length, 0);
});

test("a prompt snapshot switches once, inside the cross-fade", () => {
  const { host, calls } = fakeHost();
  const run = harness(host);
  run.switchTheme("full");
  assert.equal(run.updates(), 0, "waits for the snapshot");
  calls[0]?.callback();
  assert.equal(run.updates(), 1);
  run.timers[0]?.run();
  assert.equal(run.updates(), 1, "the deadline is a no-op after the switch");
  assert.equal(calls[0]?.skipped, false);
});

test("a frame-starved window still switches at the deadline, exactly once", () => {
  const { host, calls } = fakeHost();
  const run = harness(host);
  run.switchTheme("full");
  assert.equal(run.timers[0]?.ms, THEME_TRANSITION_DEADLINE_MS);
  run.timers[0]?.run();
  assert.equal(run.updates(), 1, "applied without the fade");
  assert.equal(calls[0]?.skipped, true);
  calls[0]?.callback();
  assert.equal(run.updates(), 1, "a late browser callback does not re-apply");
});

test("hidden pages and engines without view transitions switch at once", () => {
  const hidden = fakeHost("hidden");
  const onHidden = harness(hidden.host);
  onHidden.switchTheme("full");
  assert.equal(onHidden.updates(), 1);
  assert.equal(hidden.calls.length, 0);

  for (const host of [{ visibilityState: "visible" as const }, null]) {
    const run = harness(host);
    run.switchTheme("full");
    assert.equal(run.updates(), 1);
  }
});
