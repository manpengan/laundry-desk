import assert from "node:assert/strict";
import test from "node:test";
import {
  applyThemeToDocument,
  cycleThemePreference,
  resolveTheme,
  themePreferenceLabel,
} from "./theme.js";

test("resolveTheme respects explicit and system preference", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("cycleThemePreference rotates light → dark → system → light", () => {
  assert.equal(cycleThemePreference("light"), "dark");
  assert.equal(cycleThemePreference("dark"), "system");
  assert.equal(cycleThemePreference("system"), "light");
});

test("applyThemeToDocument sets data-theme", () => {
  const el = { dataset: {} as DOMStringMap };
  const doc = { documentElement: el as unknown as HTMLElement };
  applyThemeToDocument(doc, "dark");
  assert.equal(el.dataset.theme, "dark");
  assert.match(themePreferenceLabel("system"), /系统/);
});
