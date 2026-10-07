/**
 * ADR-99 appearance: a colour palette (配色) and a motion tier next to the light /
 * dark mode in theme.ts. All three are device-local and land on <html> as
 * data-theme / data-palette / data-motion, which @laundry/ui tokens key off.
 */
import {
  browserThemeStorage,
  initialCounterTheme,
  resolveTheme,
  type ResolvedTheme,
} from "./theme.js";

export type ThemePalette = "sky" | "sea" | "bamboo" | "sakura" | "amber" | "aurora";
export type MotionPreference = "auto" | "full" | "calm" | "off";
export type ResolvedMotion = "full" | "calm" | "off";

export const THEME_PALETTES: readonly ThemePalette[] = Object.freeze([
  "sky",
  "sea",
  "bamboo",
  "sakura",
  "amber",
  "aurora",
]);
export const MOTION_PREFERENCES: readonly MotionPreference[] = Object.freeze([
  "auto",
  "full",
  "calm",
  "off",
]);
export const DEFAULT_PALETTE: ThemePalette = "sky";
export const DEFAULT_MOTION: MotionPreference = "auto";
export const PALETTE_STORAGE_KEY = "ld.counter.palette";
export const MOTION_STORAGE_KEY = "ld.counter.motion";

type PaletteCopy = Readonly<{ label: string; note: string; pinyin: string }>;

const PALETTE_COPY: Readonly<Record<ThemePalette, PaletteCopy>> = Object.freeze({
  sky: { label: "晴空", note: "通透蓝 · 默认", pinyin: "qingkong qk blue" },
  sea: { label: "海盐", note: "清水青绿", pinyin: "haiyan hy teal" },
  bamboo: { label: "青竹", note: "竹叶新绿", pinyin: "qingzhu qz green" },
  sakura: { label: "樱花", note: "柔粉杏色", pinyin: "yinghua yh pink" },
  amber: { label: "暖阳", note: "琥珀晚霞", pinyin: "nuanyang ny amber" },
  aurora: { label: "极光", note: "紫晶电光", pinyin: "jiguang jg violet" },
});

const MOTION_LABELS: Readonly<Record<MotionPreference, string>> = Object.freeze({
  auto: "自动",
  full: "标准",
  calm: "节能",
  off: "关闭",
});

export function paletteLabel(palette: ThemePalette): string {
  return PALETTE_COPY[palette].label;
}

export function paletteNote(palette: ThemePalette): string {
  return PALETTE_COPY[palette].note;
}

/** Command palette search terms (pinyin, initials, English hue). */
export function paletteKeywords(palette: ThemePalette): string {
  return `${palette} ${PALETTE_COPY[palette].pinyin}`;
}

export function motionPreferenceLabel(motion: MotionPreference): string {
  return MOTION_LABELS[motion];
}

export function parsePalette(value: unknown): ThemePalette | null {
  return THEME_PALETTES.find((palette) => palette === value) ?? null;
}

export function parseMotionPreference(value: unknown): MotionPreference | null {
  return MOTION_PREFERENCES.find((motion) => motion === value) ?? null;
}

export type MotionEnvironment = Readonly<{ reducedMotion: boolean; softwareRendering: boolean }>;

/** System reduce-motion always wins (ADR 2026-07-18 §2.7-4); auto spares software renderers. */
export function resolveMotion(
  preference: MotionPreference,
  env: MotionEnvironment,
): ResolvedMotion {
  if (env.reducedMotion) return "off";
  if (preference === "auto") return env.softwareRendering ? "calm" : "full";
  return preference;
}

type AppearanceStorage = Pick<Storage, "getItem" | "setItem">;

function readStored<T>(
  storage: AppearanceStorage | null,
  key: string,
  parse: (value: unknown) => T | null,
): T | null {
  if (storage === null) return null;
  try {
    return parse(storage.getItem(key));
  } catch {
    return null;
  }
}

function writeStored(storage: AppearanceStorage | null, key: string, value: string): void {
  if (storage === null) return;
  try {
    storage.setItem(key, value);
  } catch {
    // A full or blocked store only loses the convenience, never the session.
  }
}

export function initialPalette(storage: AppearanceStorage | null): ThemePalette {
  return readStored(storage, PALETTE_STORAGE_KEY, parsePalette) ?? DEFAULT_PALETTE;
}

export function initialMotionPreference(storage: AppearanceStorage | null): MotionPreference {
  return readStored(storage, MOTION_STORAGE_KEY, parseMotionPreference) ?? DEFAULT_MOTION;
}

export function writeStoredPalette(storage: AppearanceStorage | null, palette: ThemePalette) {
  writeStored(storage, PALETTE_STORAGE_KEY, palette);
}

export function writeStoredMotion(storage: AppearanceStorage | null, motion: MotionPreference) {
  writeStored(storage, MOTION_STORAGE_KEY, motion);
}

export type AppliedAppearance = Readonly<{
  theme: ResolvedTheme;
  palette: ThemePalette;
  motion: ResolvedMotion;
}>;

export function applyAppearanceToDocument(
  doc: Pick<Document, "documentElement">,
  appearance: AppliedAppearance,
): void {
  const { dataset } = doc.documentElement;
  dataset.theme = appearance.theme;
  dataset.palette = appearance.palette;
  dataset.motion = appearance.motion;
}

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|basic render|software|\bwarp\b/iu;
let softwareRenderingCache: boolean | null = null;

/**
 * True when the renderer has no usable GPU (SwiftShader, WARP, llvmpipe), as on
 * remote sessions or PCs without a driver. Probed once with a throwaway WebGL
 * context; no context at all counts as software.
 */
export function detectSoftwareRendering(doc: Document | null = globalDocument()): boolean {
  if (softwareRenderingCache !== null) return softwareRenderingCache;
  if (doc === null) return false;
  softwareRenderingCache = probeSoftwareRendering(doc);
  return softwareRenderingCache;
}

export function probeSoftwareRendering(doc: Pick<Document, "createElement">): boolean {
  try {
    const canvas = doc.createElement("canvas");
    const gl = canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true });
    if (gl === null) return true;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info === null ? "" : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return SOFTWARE_RENDERER.test(renderer);
  } catch {
    return true;
  }
}

function globalDocument(): Document | null {
  return typeof document === "undefined" ? null : document;
}

function matches(query: string): boolean {
  return typeof window !== "undefined" && window.matchMedia(query).matches;
}

export function readSystemDark(): boolean {
  return matches("(prefers-color-scheme: dark)");
}

export function readReducedMotion(): boolean {
  return matches("(prefers-reduced-motion: reduce)");
}

export function readMotionEnvironment(preference: MotionPreference): MotionEnvironment {
  return Object.freeze({
    reducedMotion: readReducedMotion(),
    // Only "auto" needs the probe; explicit choices never pay for a WebGL context.
    softwareRendering: preference === "auto" && detectSoftwareRendering(),
  });
}

/**
 * Startup: apply the stored appearance before React renders, so the login page
 * and the first shell frame already wear the chosen theme (no flash of 晴空).
 */
export function bootAppearance(doc: Document | null = globalDocument()): void {
  if (doc === null) return;
  const storage = browserThemeStorage();
  const motion = initialMotionPreference(storage);
  applyAppearanceToDocument(doc, {
    theme: resolveTheme(initialCounterTheme(storage), readSystemDark()),
    palette: initialPalette(storage),
    motion: resolveMotion(motion, readMotionEnvironment(motion)),
  });
}
