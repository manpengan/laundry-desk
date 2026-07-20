/** Design tokens — TS mirror of src/styles/tokens.css (liquid glass v1 → packages/ui). */

export const colors = {
  accent: "var(--lg-accent)",
  accentSoft: "var(--lg-accent-soft)",
  ink: "var(--lg-ink)",
  inkMuted: "var(--lg-ink2)",
  success: "var(--lg-ok-ink)",
  successBg: "var(--lg-ok-bg)",
  warning: "var(--lg-warn-ink)",
  warningBg: "var(--lg-warn-bg)",
  danger: "var(--lg-late-ink)",
  dangerBg: "var(--lg-late-bg)",
  info: "var(--lg-info-ink)",
  infoBg: "var(--lg-info-bg)",
  glass: "var(--lg-glass)",
  surface: "var(--lg-surface)",
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

export const shadows = {
  xs: "var(--lg-shadow-xs)",
  sm: "var(--lg-shadow-sm)",
  md: "var(--lg-shadow)",
} as const;

/** px — 等宽档用于金额/票号 */
export const fontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 28,
  display: 40,
} as const;

export const motion = {
  fastMs: 150,
  baseMs: 250,
} as const;

export const spacing = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
} as const;

export const tokens = {
  colors,
  radii,
  shadows,
  fontSize,
  motion,
  spacing,
} as const;
