import { flushSync } from "react-dom";

import type { ResolvedMotion } from "../appearance.js";

type ViewTransitionLike = Readonly<{ skipTransition?: () => void }> | undefined;

/** The slice of Document a theme switch touches (tests pass a fake). */
export type TransitionHost = Readonly<{
  visibilityState?: DocumentVisibilityState;
  startViewTransition?: (update: () => void) => ViewTransitionLike;
}>;

export type ThemeTransitionDeps = Readonly<{
  host: TransitionHost | null;
  schedule: (run: () => void, ms: number) => unknown;
  commit: (update: () => void) => void;
}>;

/**
 * A cross-fade only starts once the old frame is captured, so a window that
 * produces no frames (locked session, occluded, busy compositor) would leave
 * the old theme on screen indefinitely. Past this deadline the switch is
 * applied without the fade (ADR-99 revision, Windows acceptance run-7d07cb87).
 */
export const THEME_TRANSITION_DEADLINE_MS = 250;

function browserDeps(): ThemeTransitionDeps {
  return {
    host: typeof document === "undefined" ? null : document,
    schedule: (run, ms) => setTimeout(run, ms),
    commit: flushSync,
  };
}

/**
 * Theme switches cross-fade through a view transition at full motion only. The
 * update runs at most once: inside the transition (flushSync, so the new
 * snapshot already carries the new data-* attributes) or, if the transition has
 * not called back by the deadline, directly with the fade skipped.
 */
export function runThemeTransition(
  motion: ResolvedMotion,
  update: () => void,
  deps: ThemeTransitionDeps = browserDeps(),
): void {
  const { host, schedule, commit } = deps;
  if (
    motion !== "full" ||
    host === null ||
    host.visibilityState === "hidden" ||
    typeof host.startViewTransition !== "function"
  ) {
    update();
    return;
  }
  let applied = false;
  const apply = (): void => {
    if (applied) return;
    applied = true;
    commit(update);
  };
  const transition = host.startViewTransition(apply);
  schedule(() => {
    if (applied) return;
    transition?.skipTransition?.();
    apply();
  }, THEME_TRANSITION_DEADLINE_MS);
}
