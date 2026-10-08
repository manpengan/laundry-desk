import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";

import {
  applyAppearanceToDocument,
  initialMotionPreference,
  initialPalette,
  readMotionEnvironment,
  readReducedMotion,
  readSystemDark,
  resolveMotion,
  syncThemeColor,
  writeStoredMotion,
  writeStoredPalette,
  type MotionEnvironment,
  type MotionPreference,
  type ResolvedMotion,
  type ThemePalette,
} from "../appearance.js";
import {
  browserThemeStorage,
  initialCounterTheme,
  resolveTheme,
  writeStoredThemePreference,
  type ThemePreference,
} from "../theme.js";
import type { ThemeControl } from "./shell-shortcuts.js";
import { runThemeTransition } from "./theme-transition.js";

/** Re-evaluates a media query on change (system theme / reduce motion). */
function useMediaQuery(query: string, read: () => boolean, fixed?: boolean): boolean {
  const [value, setValue] = useState(() => fixed ?? read());
  useEffect(() => {
    if (fixed !== undefined || typeof window === "undefined") return undefined;
    const media = window.matchMedia(query);
    const sync = (): void => setValue(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [query, fixed]);
  return fixed ?? value;
}

export type AppearanceOptions = Readonly<{
  initialTheme?: ThemePreference | undefined;
  /** Tests pin the system preference; production follows the OS live. */
  systemDark?: boolean | undefined;
  documentRef?: Pick<Document, "documentElement"> | null | undefined;
}>;

export function useAppearance({ initialTheme, systemDark, documentRef }: AppearanceOptions) {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    () => initialTheme ?? initialCounterTheme(browserThemeStorage()),
  );
  const [palette, setPaletteState] = useState<ThemePalette>(() =>
    initialPalette(browserThemeStorage()),
  );
  const [motion, setMotionState] = useState<MotionPreference>(() =>
    initialMotionPreference(browserThemeStorage()),
  );
  const dark = useMediaQuery("(prefers-color-scheme: dark)", readSystemDark, systemDark);
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)", readReducedMotion);
  const environment = useMemo<MotionEnvironment>(
    () => ({ ...readMotionEnvironment(motion), reducedMotion: reduced }),
    [motion, reduced],
  );
  const resolvedMotion = resolveMotion(motion, environment);
  const theme = resolveTheme(preference, dark);

  useLayoutEffect(() => {
    const doc = documentRef ?? (typeof document !== "undefined" ? document : null);
    if (doc === null) return;
    applyAppearanceToDocument(doc, { theme, palette, motion: resolvedMotion });
    if (typeof document !== "undefined" && doc === document) syncThemeColor(document);
  }, [theme, palette, resolvedMotion, documentRef]);

  return useAppearanceControl(
    { preference, palette, motion, resolvedMotion },
    { setPreferenceState, setPaletteState, setMotionState },
  );
}

type AppearanceValues = Readonly<{
  preference: ThemePreference;
  palette: ThemePalette;
  motion: MotionPreference;
  resolvedMotion: ResolvedMotion;
}>;

type AppearanceSetters = Readonly<{
  setPreferenceState: (value: ThemePreference) => void;
  setPaletteState: (value: ThemePalette) => void;
  setMotionState: (value: MotionPreference) => void;
}>;

function useAppearanceControl(values: AppearanceValues, setters: AppearanceSetters): ThemeControl {
  const { preference, palette, motion, resolvedMotion } = values;
  const { setPreferenceState, setPaletteState, setMotionState } = setters;
  const setPreference = useCallback(
    (next: ThemePreference) => {
      writeStoredThemePreference(browserThemeStorage(), next);
      runThemeTransition(resolvedMotion, () => setPreferenceState(next));
    },
    [resolvedMotion, setPreferenceState],
  );
  const setPalette = useCallback(
    (next: ThemePalette) => {
      writeStoredPalette(browserThemeStorage(), next);
      runThemeTransition(resolvedMotion, () => setPaletteState(next));
    },
    [resolvedMotion, setPaletteState],
  );
  const setMotion = useCallback(
    (next: MotionPreference) => {
      writeStoredMotion(browserThemeStorage(), next);
      setMotionState(next);
    },
    [setMotionState],
  );
  return useMemo(
    () =>
      Object.freeze({
        preference,
        setPreference,
        palette,
        setPalette,
        motion,
        resolvedMotion,
        setMotion,
      }),
    [preference, setPreference, palette, setPalette, motion, resolvedMotion, setMotion],
  );
}
