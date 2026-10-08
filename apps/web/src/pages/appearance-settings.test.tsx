import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ThemeControlContext, type ThemeControl } from "../shell/shell-shortcuts.js";
import { AppearanceSettingsPanel, motionNote } from "./AppearanceSettingsPanel.js";

const noop = () => undefined;

function control(overrides: Partial<ThemeControl> = {}): ThemeControl {
  return Object.freeze({
    preference: "dark" as const,
    setPreference: noop,
    palette: "sea" as const,
    setPalette: noop,
    motion: "auto" as const,
    resolvedMotion: "full" as const,
    setMotion: noop,
    ...overrides,
  });
}

function render(theme: ThemeControl | null): string {
  return renderToStaticMarkup(
    <ThemeControlContext.Provider value={theme}>
      <AppearanceSettingsPanel />
    </ThemeControlContext.Provider>,
  );
}

test("外观 offers six palette cards, light/dark and motion as radio groups", () => {
  const html = render(control());
  assert.match(html, /role="radiogroup" aria-label="主题配色"/u);
  assert.equal((html.match(/class="ld-theme-card"/gu) ?? []).length, 6);
  assert.match(html, /role="radio" aria-checked="true" aria-label="海盐" tabindex="0"/u);
  assert.match(html, /role="radio" aria-checked="false" aria-label="极光" tabindex="-1"/u);
  assert.match(html, /data-palette="aurora"/u, "each card previews its own palette");
  assert.match(html, /role="radiogroup" aria-label="明暗"/u);
  assert.match(html, /role="radio" aria-checked="true" tabindex="0"[^>]*>深色/u);
  assert.match(html, /role="radiogroup" aria-label="动态效果"/u);
  assert.match(html, /role="radio" aria-checked="true" tabindex="0"[^>]*>自动/u);
  assert.doesNotMatch(html, /\sstyle=/u);
});

test("the smoothness self-test is offered, but never against system reduce-motion", () => {
  const html = render(control());
  assert.match(html, /class="ld-settings-appearance__test" aria-live="polite"/u);
  assert.match(html, /<button[^>]*>检测流畅度<\/button>/u);
  assert.doesNotMatch(html, /<button[^>]*>改用节能<\/button>/u, "no advice before a measurement");
  const reduced = render(control({ motion: "auto", resolvedMotion: "off" }));
  assert.match(reduced, /<button[^>]*disabled=""[^>]*>检测流畅度<\/button>/u);
});

test("without a shell theme control only the shortcut reference renders", () => {
  const html = render(null);
  assert.doesNotMatch(html, /radiogroup/u);
  assert.match(html, /ld-settings-shortcuts/u);
});

test("the motion note explains what this device actually runs", () => {
  assert.match(motionNote({ motion: "auto", resolvedMotion: "calm" }), /没有可用的显卡加速/u);
  assert.match(motionNote({ motion: "auto", resolvedMotion: "full" }), /缓慢流动/u);
  assert.match(motionNote({ motion: "full", resolvedMotion: "off" }), /减少动态效果/u);
  assert.match(motionNote({ motion: "calm", resolvedMotion: "calm" }), /背景静止/u);
  assert.match(motionNote({ motion: "off", resolvedMotion: "off" }), /不播放动画/u);
  assert.match(motionNote({ motion: "full", resolvedMotion: "full" }), /极光背景/u);
});
