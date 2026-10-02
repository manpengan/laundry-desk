/** Theme preference for counter UI (UI spec §1.8: 柜台默认浅色，可手动覆盖). */

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** UI spec §1.8 — counters sit in bright shops; light is the default. */
export const COUNTER_DEFAULT_THEME: ThemePreference = "light";
export const THEME_STORAGE_KEY = "ld.counter.theme";

export const THEME_PREFERENCES: readonly ThemePreference[] = Object.freeze([
  "light",
  "dark",
  "system",
]);

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/** Apply theme to document root via data-theme (matches @laundry/ui tokens). */
export function applyThemeToDocument(
  doc: Pick<Document, "documentElement">,
  theme: ResolvedTheme,
): void {
  doc.documentElement.dataset.theme = theme;
}

export function cycleThemePreference(current: ThemePreference): ThemePreference {
  if (current === "light") return "dark";
  if (current === "dark") return "system";
  return "light";
}

export function themePreferenceLabel(preference: ThemePreference): string {
  if (preference === "light") return "浅色";
  if (preference === "dark") return "深色";
  return "跟随系统";
}

export function parseThemePreference(value: unknown): ThemePreference | null {
  return value === "light" || value === "dark" || value === "system" ? value : null;
}

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

/** Device-local preference; storage can be absent or throw (private mode). */
export function browserThemeStorage(): ThemeStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredThemePreference(storage: ThemeStorage | null): ThemePreference | null {
  if (storage === null) return null;
  try {
    return parseThemePreference(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeStoredThemePreference(
  storage: ThemeStorage | null,
  preference: ThemePreference,
): void {
  if (storage === null) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A full or blocked store only loses the convenience, never the session.
  }
}

/** Startup preference for the counter: stored choice, else the spec default. */
export function initialCounterTheme(storage: ThemeStorage | null): ThemePreference {
  return readStoredThemePreference(storage) ?? COUNTER_DEFAULT_THEME;
}
