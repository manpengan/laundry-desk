import assert from "node:assert/strict";
import test from "node:test";

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
  return {
    frames,
    timers,
    cancelled: () => cancelled,
    clock: {
      requestAnimationFrame: (tick: (now: number) => void) => frames.push(tick),
      cancelAnimationFrame: () => void (cancelled += 1),
      setTimeout: (run: () => void) => timers.push(run),
    } as unknown as Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame" | "setTimeout">,
  };
}

test("sampling ends on its timer even when frames stop", async () => {
  const fake = fakeClock();
  const sampled = measureFrames(fake.clock, SELF_TEST_MS);
  fake.frames.shift()?.(1000);
  fake.frames.shift()?.(1016);
  fake.frames.shift()?.(1050);
  fake.timers.shift()?.();
  assert.deepEqual(await sampled, [16, 34]);
  assert.equal(fake.cancelled(), 1);
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
  fake.timers.shift()?.(); // warm-up elapses
  await settle();
  during?.();
  fake.frames.shift()?.(0);
  fake.timers.shift()?.(); // sampling window ends
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
