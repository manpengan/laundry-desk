/** Theme preference for counter UI (UI spec §1.8). */

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

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
