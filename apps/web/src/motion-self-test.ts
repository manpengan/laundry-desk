/**
 * 设置 → 外观 → 检测流畅度 (ADR-99 revision): samples frame intervals for a few
 * seconds at the standard tier, so a store PC's motion setting rests on a
 * measurement instead of the "auto" GPU heuristic alone. Renderer-only.
 */

import { previewMotion } from "./appearance.js";

export type FrameVerdict = "smooth" | "borderline" | "slow";

export type FrameReport = Readonly<{
  frames: number;
  fps: number;
  /** Share of slow intervals (0…1), including a stalled final interval. */
  slowShare: number;
  worstMs: number;
  verdict: FrameVerdict;
}>;

/** A frame this long misses a 60 Hz deadline by half a frame or more. */
export const SLOW_FRAME_MS = 25;
export const SELF_TEST_MS = 3000;
/** Lets the drift animations start before sampling. */
export const SELF_TEST_WARMUP_MS = 300;

/** Include the final uncompleted interval in elapsed time without counting another frame. */
export function summarizeFrames(deltas: readonly number[], trailingMs = 0): FrameReport {
  const frames = deltas.length;
  const total = deltas.reduce((sum, delta) => sum + delta, trailingMs);
  const fps = total > 0 ? (frames * 1000) / total : 0;
  const stalled = trailingMs > SLOW_FRAME_MS ? 1 : 0;
  const slowShare =
    frames > 0
      ? (deltas.filter((delta) => delta > SLOW_FRAME_MS).length + stalled) / (frames + stalled)
      : 1;
  const verdict: FrameVerdict =
    fps >= 55 && slowShare <= 0.05
      ? "smooth"
      : fps >= 40 && slowShare <= 0.15
        ? "borderline"
        : "slow";
  return Object.freeze({
    frames,
    fps: Math.round(fps),
    slowShare,
    worstMs: Math.round(Math.max(trailingMs, ...deltas)),
    verdict,
  });
}

const VERDICT_TEXT: Readonly<Record<FrameVerdict, string>> = Object.freeze({
  smooth: "流畅，可以使用标准动效。",
  borderline: "略有卡顿，建议改用节能。",
  slow: "明显卡顿，建议改用节能。",
});

export function frameReportText(report: FrameReport): string {
  const slow = Math.round(report.slowShare * 100);
  return `平均 ${report.fps} 帧/秒，慢帧 ${slow}%：${VERDICT_TEXT[report.verdict]}`;
}

type FrameClock = Pick<
  Window,
  "requestAnimationFrame" | "cancelAnimationFrame" | "setTimeout" | "performance"
>;

type FrameSample = Readonly<{ deltas: readonly number[]; trailingMs: number }>;

/** Include time before the first frame and after the last; use the actual timer completion. */
export function measureFrames(clock: FrameClock, durationMs: number): Promise<FrameSample> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let last = clock.performance.now();
    let frame = 0;
    const tick = (): void => {
      const now = clock.performance.now();
      deltas.push(now - last);
      last = now;
      frame = clock.requestAnimationFrame(tick);
    };
    frame = clock.requestAnimationFrame(tick);
    clock.setTimeout(() => {
      clock.cancelAnimationFrame(frame);
      resolve({ deltas, trailingMs: clock.performance.now() - last });
    }, durationMs);
  });
}

/**
 * Runs the standard tier for the measurement, then hands <html data-motion>
 * back, unless a setting changed it meanwhile.
 */
export async function runMotionSelfTest(doc: Document): Promise<FrameReport> {
  const view = doc.defaultView;
  if (view === null) return summarizeFrames([]);
  const restoreMotion = previewMotion(doc, "full");
  try {
    await new Promise((resolve) => view.setTimeout(resolve, SELF_TEST_WARMUP_MS));
    const sample = await measureFrames(view, SELF_TEST_MS);
    return summarizeFrames(sample.deltas, sample.trailingMs);
  } finally {
    restoreMotion();
  }
}
