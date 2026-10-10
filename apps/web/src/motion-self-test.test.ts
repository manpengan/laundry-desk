import assert from "node:assert/strict";
import test from "node:test";
import { applyAppearanceToDocument } from "./appearance.js";

import {
  frameReportText,
  measureFrames,
  runMotionSelfTest,
  SELF_TEST_MS,
  SELF_TEST_WARMUP_MS,
  summarizeFrames,
} from "./motion-self-test.js";

const at = (ms: number, count: number) => Array.from({ length: count }, () => ms);

test("60 Hz and faster panels read as smooth; long frames tip the verdict", () => {
  assert.equal(summarizeFrames(at(16.7, 180)).verdict, "smooth");
  assert.equal(summarizeFrames(at(6.06, 495)).fps, 165);
  assert.equal(summarizeFrames([...at(16.7, 170), ...at(40, 10)]).verdict, "borderline");
  assert.equal(summarizeFrames(at(33.4, 90)).verdict, "slow");
  const empty = summarizeFrames([]);
  assert.deepEqual([empty.frames, empty.fps, empty.verdict], [0, 0, "slow"]);
  assert.equal(summarizeFrames([16, 16, 120]).worstMs, 120);
});

test("the report reads as one line of plain Chinese", () => {
  const text = frameReportText(summarizeFrames([...at(16.7, 170), ...at(40, 10)]));
  assert.match(text, /^平均 \d+ 帧\/秒，慢帧 6%：略有卡顿，建议改用节能。$/u);
  assert.match(frameReportText(summarizeFrames(at(16.7, 180))), /流畅，可以使用标准动效/u);
});

function fakeClock() {
  const frames: ((now: number) => void)[] = [];
  const timers: (() => void)[] = [];
  let cancelled = 0;
  let now = 0;
  return {
    frames,
    timers,
    tick: (at: number) => {
      now = at;
      frames.shift()?.(at);
    },
    finish: (at: number) => {
      now = at;
      timers.shift()?.();
    },
    cancelled: () => cancelled,
    clock: {
      requestAnimationFrame: (tick: (now: number) => void) => frames.push(tick),
      cancelAnimationFrame: () => void (cancelled += 1),
      setTimeout: (run: () => void) => timers.push(run),
      performance: { now: () => now },
    } as unknown as Parameters<typeof measureFrames>[0],
  };
}

test("sampling ends on its timer even when frames stop", async () => {
  const fake = fakeClock();
  const sampled = measureFrames(fake.clock, SELF_TEST_MS);
  fake.tick(1000);
  fake.tick(1016);
  fake.tick(1050);
  fake.finish(3000);
  assert.deepEqual(await sampled, { deltas: [1000, 16, 34], trailingMs: 1950 });
  assert.equal(fake.cancelled(), 1);
});

test("leading, trailing and total frame starvation count against the entire sampling window", async () => {
  for (const times of [[0, 16], [2984, 3000], []]) {
    const fake = fakeClock();
    const sampled = measureFrames(fake.clock, SELF_TEST_MS);
    for (const at of times) fake.tick(at);
    fake.finish(SELF_TEST_MS);
    const sample = await sampled;
    const report = summarizeFrames(sample.deltas, sample.trailingMs);
    assert.equal(report.frames, times.length);
    assert.equal(report.fps, Math.round((times.length * 1000) / SELF_TEST_MS));
    assert.equal(report.verdict, "slow");
    assert.ok(report.worstMs >= 2984);
    assert.ok(report.slowShare > 0);
  }
});

test("a delayed timeout uses actual elapsed time, while steady frames remain smooth", async () => {
  for (const end of [3000, 6000]) {
    const fake = fakeClock();
    const sampled = measureFrames(fake.clock, SELF_TEST_MS);
    for (let index = 1; index <= 180; index++) fake.tick((index * 3000) / 180);
    fake.finish(end);
    const sample = await sampled;
    const report = summarizeFrames(sample.deltas, sample.trailingMs);
    assert.equal(report.frames, 180);
    assert.equal(report.fps, end === 3000 ? 60 : 30);
    assert.equal(report.verdict, end === 3000 ? "smooth" : "slow");
  }
});

function fakeDocument(motion: string | undefined) {
  const fake = fakeClock();
  const dataset: Record<string, string | undefined> = motion === undefined ? {} : { motion };
  const doc = {
    defaultView: fake.clock,
    documentElement: { dataset },
  } as unknown as Document;
  return { doc, dataset, fake };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function drive(fake: ReturnType<typeof fakeClock>, during?: () => void) {
  fake.finish(SELF_TEST_WARMUP_MS);
  await settle();
  during?.();
  fake.tick(SELF_TEST_WARMUP_MS + 16);
  fake.finish(SELF_TEST_WARMUP_MS + SELF_TEST_MS);
  await settle();
}

test("the self-test runs at full motion and hands the tier back", async () => {
  const calm = fakeDocument("calm");
  const report = runMotionSelfTest(calm.doc);
  assert.equal(calm.dataset.motion, "full", "measures the standard tier");
  await drive(calm.fake);
  await report;
  assert.equal(calm.dataset.motion, "calm");

  const changed = fakeDocument("full");
  const second = runMotionSelfTest(changed.doc);
  await drive(changed.fake, () => (changed.dataset.motion = "off"));
  await second;
  assert.equal(changed.dataset.motion, "off", "a setting changed meanwhile wins");
  assert.ok(SELF_TEST_WARMUP_MS < SELF_TEST_MS);
});

test("selecting standard during a calm self-test keeps standard when the test ends", async () => {
  const view = fakeDocument("calm");
  const report = runMotionSelfTest(view.doc);
  await drive(view.fake, () => {
    // The same path used by useAppearance when the user changes the preference.
    applyAppearanceToDocument(view.doc, { theme: "light", palette: "sky", motion: "full" });
  });
  await report;
  assert.equal(view.dataset.motion, "full");
});

test("system reduced motion and the latest appearance win over the temporary preview", async () => {
  for (const motion of ["off", "calm", "full"] as const) {
    const view = fakeDocument("calm");
    const report = runMotionSelfTest(view.doc);
    await drive(view.fake, () => {
      applyAppearanceToDocument(view.doc, { theme: "dark", palette: "sea", motion: "full" });
      applyAppearanceToDocument(view.doc, { theme: "dark", palette: "sea", motion });
    });
    await report;
    assert.equal(view.dataset.motion, motion);
  }
});
