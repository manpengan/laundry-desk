/**
 * ADR-99 revision: the renderer mirrors its canvas colour into
 * <meta name="theme-color">, Electron reports it via did-change-theme-color,
 * and the native window background follows. The window is shown after the
 * page has loaded, so a dark theme no longer flashes the light background
 * around show, maximise or resize. No IPC channel or contract is involved.
 */

const THEME_COLOR = /^#[0-9a-f]{6}$/iu;

/** Pure: the background to apply for a did-change-theme-color payload, if any. */
export function themeBackground(color: unknown): string | null {
  return typeof color === "string" && THEME_COLOR.test(color) ? color : null;
}

export type ThemeColorSubscription = (listener: (color: string | null) => void) => void;

export function followThemeColor(
  subscribe: ThemeColorSubscription,
  target: Readonly<{ setBackgroundColor: (color: string) => void }>,
): void {
  subscribe((color) => {
    const background = themeBackground(color);
    if (background !== null) target.setBackgroundColor(background);
  });
}
