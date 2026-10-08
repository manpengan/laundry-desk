/**
 * 设置 → 外观 → 检测流畅度 (ADR-99 revision): samples frame intervals for a few
 * seconds at the standard tier, so a store PC's motion setting rests on a
 * measurement instead of the "auto" GPU heuristic alone. Renderer-only.
 */

export type FrameVerdict = "smooth" | "borderline" | "slow";

export type FrameReport = Readonly<{
  frames: number;
  fps: number;
  /** Share of frames slower than SLOW_FRAME_MS (0…1). */
  slowShare: number;
  worstMs: number;
  verdict: FrameVerdict;
}>;

/** A frame this long misses a 60 Hz deadline by half a frame or more. */
export const SLOW_FRAME_MS = 25;
export const SELF_TEST_MS = 3000;
/** Lets the drift animations start before sampling. */
export const SELF_TEST_WARMUP_MS = 300;

/** Pure: summary and verdict for a list of frame intervals in milliseconds. */
export function summarizeFrames(deltas: readonly number[]): FrameReport {
  const frames = deltas.length;
  const total = deltas.reduce((sum, delta) => sum + delta, 0);
  const fps = total > 0 ? (frames * 1000) / total : 0;
  const slowShare =
    frames > 0 ? deltas.filter((delta) => delta > SLOW_FRAME_MS).length / frames : 1;
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
    worstMs: frames > 0 ? Math.round(Math.max(...deltas)) : 0,
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

type FrameClock = Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame" | "setTimeout">;

/** Frame intervals for `durationMs`; a timer ends it even if frames stop. */
export function measureFrames(clock: FrameClock, durationMs: number): Promise<number[]> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let last = -1;
    let frame = 0;
    const tick = (now: number): void => {
      if (last >= 0) deltas.push(now - last);
      last = now;
      frame = clock.requestAnimationFrame(tick);
    };
    frame = clock.requestAnimationFrame(tick);
    clock.setTimeout(() => {
      clock.cancelAnimationFrame(frame);
      resolve(deltas);
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
  const root = doc.documentElement;
  const previous = root.dataset.motion;
  root.dataset.motion = "full";
  try {
    await new Promise((resolve) => view.setTimeout(resolve, SELF_TEST_WARMUP_MS));
    return summarizeFrames(await measureFrames(view, SELF_TEST_MS));
  } finally {
    if (root.dataset.motion === "full") {
      if (previous === undefined) delete root.dataset.motion;
      else root.dataset.motion = previous;
    }
  }
}
