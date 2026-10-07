/**
 * ADR-99: every palette × light/dark keeps WCAG AA, computed from the shipped CSS.
 * Backgrounds are composited the way the counter stacks them (aurora field at its
 * strongest, glass, card), so the check holds wherever the colour fields drift.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type Rgba = readonly [number, number, number, number];
type Tokens = ReadonlyMap<string, string>;

const PALETTES = ["sky", "sea", "bamboo", "sakura", "amber", "aurora"] as const;
const SEEDS = [
  "accent",
  "accent2",
  "accent-strong",
  "accent-fill",
  "accent-fill-hover",
  "bg",
  "aurora-1",
  "aurora-2",
  "aurora-3",
  "aurora-4",
];

function css(name: string): string {
  return readFileSync(new URL(`../../src/styles/${name}`, import.meta.url), "utf8");
}

function declarations(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of block.matchAll(/--lg-([\w-]+):\s*([^;]+);/gu)) {
    tokens.set(match[1] ?? "", (match[2] ?? "").replace(/\s+/gu, " ").trim());
  }
  return tokens;
}

function block(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing ${selector}`);
  return source.slice(start, source.indexOf("\n}", start));
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  return [...parts, current.trim()];
}

function mix(value: string, tokens: Tokens): Rgba {
  const [, first = "", second = ""] = splitTopLevel(value.slice("color-mix(".length, -1));
  const weight = Number(/(\d+(?:\.\d+)?)%\s*$/u.exec(first)?.[1] ?? "50") / 100;
  const a = color(first.replace(/\s+\d+(?:\.\d+)?%\s*$/u, ""), tokens);
  const b = color(second, tokens);
  const alpha = a[3] * weight + b[3] * (1 - weight);
  if (alpha === 0) return [0, 0, 0, 0];
  const channel = (i: 0 | 1 | 2) => (a[i] * a[3] * weight + b[i] * b[3] * (1 - weight)) / alpha;
  return [channel(0), channel(1), channel(2), alpha];
}

function color(raw: string, tokens: Tokens): Rgba {
  const value = raw.trim();
  const variable = /^var\(--lg-([\w-]+)\)$/u.exec(value);
  if (variable) return color(tokens.get(variable[1] ?? "") ?? "unset", tokens);
  if (value === "transparent") return [0, 0, 0, 0];
  if (value.startsWith("color-mix(")) return mix(value, tokens);
  const hex = /^#([0-9a-f]{6})$/iu.exec(value)?.[1];
  if (hex) {
    const byte = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return [byte(0), byte(2), byte(4), 1];
  }
  const rgba = /^rgba?\(([^)]+)\)$/u.exec(value)?.[1];
  assert.ok(rgba, `unsupported colour ${value}`);
  const [r = 0, g = 0, b = 0, a = 1] = rgba.split(",").map(Number);
  return [r, g, b, a];
}

function over(top: Rgba, under: Rgba): Rgba {
  const blend = (i: 0 | 1 | 2) => top[i] * top[3] + under[i] * (1 - top[3]);
  return [blend(0), blend(1), blend(2), 1];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(text: Rgba, background: Rgba): number {
  const [hi, lo] = [luminance(over(text, background)), luminance(background)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const core = css("core-tokens.css");
const themes = css("themes.css");
const LIGHT = declarations(block(core, ":root"));
const BASE = {
  light: LIGHT,
  // Dark redefines a subset; the rest (accent-ink, status aliases) inherits from :root.
  dark: new Map([...LIGHT, ...declarations(block(core, ':root[data-theme="dark"]'))]),
};

function paletteTokens(palette: string, mode: "light" | "dark"): Map<string, string> {
  const selector =
    mode === "light"
      ? `[data-palette="${palette}"]`
      : `[data-theme="dark"][data-palette="${palette}"],\n[data-theme="dark"] [data-palette="${palette}"]`;
  return declarations(block(themes, selector));
}

/** Every opaque background a reading surface can sit on: bare canvas and each field. */
function canvases(tokens: Tokens): Readonly<{ bg: Rgba; fields: Rgba[] }> {
  const bg = color("var(--lg-bg)", tokens);
  const fields = [1, 2, 3, 4].map((i) => over(color(`var(--lg-aurora-${i})`, tokens), bg));
  return { bg, fields: [bg, ...fields] };
}

/** Collects the weakest pairing per check, so one run reports every failure. */
function checker() {
  const failures: string[] = [];
  const check = (label: string, text: Rgba, backgrounds: Rgba[], minimum: number) => {
    const worst = Math.min(...backgrounds.map((background) => contrast(text, background)));
    if (worst < minimum) failures.push(`${label}: ${worst.toFixed(2)} < ${minimum}`);
  };
  return { failures, check };
}

for (const palette of PALETTES) {
  for (const mode of ["light", "dark"] as const) {
    test(`palette ${palette} (${mode}) keeps WCAG AA`, () => {
      const own = paletteTokens(palette, mode);
      for (const seed of SEEDS) assert.ok(own.has(seed), `${palette}/${mode} lacks --lg-${seed}`);
      const tokens = new Map([...BASE[mode], ...own]);
      const c = (name: string) => color(`var(--lg-${name})`, tokens);
      const { bg, fields } = canvases(tokens);
      const { failures, check: assertAll } = checker();
      const cards = fields.map((field) => over(c("surface"), field));
      const glass = ["glass-hi", "glass", "glass-lo"].flatMap((g) =>
        fields.map((field) => over(c(g), field)),
      );
      const pill = glass.map((under) =>
        over(
          color("color-mix(in srgb, var(--lg-accent) 16%, var(--lg-surface-input))", tokens),
          under,
        ),
      );
      assertAll("button text on fill", c("accent-ink"), [over(c("accent-fill"), bg)], 4.5);
      assertAll("button text on hover", c("accent-ink"), [over(c("accent-fill-hover"), bg)], 4.5);
      // Only page titles (ink) and hints (ink2) sit on the bare canvas; actions,
      // weak text and accents live in cards, bars and the glass rail.
      assertAll("accent text on plain canvas", c("accent-strong"), [bg], 4.5);
      assertAll("accent text on cards", c("accent-strong"), cards, 4.5);
      assertAll("active nav label on pill", c("accent-strong"), pill, 4.5);
      assertAll("focus colour on cards", c("accent"), cards, 3);
      for (const ink of ["ink", "ink2", "ink3"]) {
        if (ink !== "ink3") assertAll(`${ink} on canvas`, c(ink), fields, 4.5);
        assertAll(`${ink} on cards`, c(ink), cards, 4.5);
        assertAll(`${ink} on glass`, c(ink), glass, 4.5);
      }
      for (const status of ["ok", "busy", "late", "warn", "done"]) {
        const chips = cards.map((card) => over(c(`${status}-bg`), card));
        assertAll(`${status} chip`, c(`${status}-ink`), chips, 4.5);
      }
      assert.deepEqual(failures, []);
    });
  }
}

test("themes.css defines exactly the six palettes, light and dark", () => {
  const light = [...themes.matchAll(/^\[data-palette="([a-z]+)"\] \{/gmu)].map((m) => m[1]);
  const dark = [...themes.matchAll(/^\[data-theme="dark"\]\[data-palette="([a-z]+)"\],/gmu)].map(
    (m) => m[1],
  );
  assert.deepEqual(light, [...PALETTES]);
  assert.deepEqual(dark, [...PALETTES]);
});
