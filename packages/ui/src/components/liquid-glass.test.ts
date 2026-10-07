import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { countUpValue, easeOutCubic } from "../lib/count-up.js";
import { flipStartTransform, restingTransform, sameBox } from "../lib/magnetic-indicator.js";
import { AuroraBackdrop } from "./AuroraBackdrop.js";
import { Tabs } from "./Tabs.js";

test("aurora backdrop is decorative, CSP-safe markup with four fields and a grain", () => {
  const markup = renderToStaticMarkup(createElement(AuroraBackdrop));
  assert.match(markup, /^<div class="lg-aurora" aria-hidden="true">/u);
  assert.equal((markup.match(/class="lg-aurora__blob"/gu) ?? []).length, 4);
  assert.match(markup, /<feTurbulence type="fractalNoise"/u);
  assert.match(markup, /filter="url\(#lg-aurora-grain\)"/u);
  assert.doesNotMatch(markup, /\sstyle=|data:|<style/u);
});

test("magnetic FLIP starts on the old box and rests on the new one", () => {
  const from = { x: 4, y: 10, w: 60, h: 40 };
  const to = { x: 70, y: 10, w: 120, h: 40 };
  assert.equal(flipStartTransform(from, to), "translate3d(4px, 10px, 0) scale(0.5, 1)");
  assert.equal(restingTransform(to), "translate3d(70px, 10px, 0)");
  assert.equal(
    flipStartTransform(from, { ...to, w: 0, h: 0 }),
    "translate3d(4px, 10px, 0) scale(1, 1)",
  );
  assert.equal(sameBox(null, to), false);
  assert.equal(sameBox({ ...to }, to), true);
  assert.equal(sameBox(from, to), false);
});

test("count-up eases out and lands exactly on integer targets", () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeOutCubic(2), 1);
  assert.ok(easeOutCubic(0.5) > 0.5, "decelerates");
  assert.equal(countUpValue(0, 39_800, 1), 39_800);
  assert.equal(countUpValue(23, 0, 1), 0);
  assert.ok(Number.isInteger(countUpValue(0, 48_600, 0.37)));
});

test("tabs render one decorative thumb and keep CSP-safe markup", () => {
  const markup = renderToStaticMarkup(
    createElement(Tabs<"a" | "b">, {
      label: "明暗",
      mode: "radio",
      items: [
        { id: "a", label: "浅色" },
        { id: "b", label: "深色" },
      ],
      value: "b",
      onChange: () => undefined,
    }),
  );
  assert.match(markup, /<span class="ld-tabs__thumb" aria-hidden="true"><span><\/span><\/span>/u);
  assert.doesNotMatch(markup, /\sstyle=|data-thumb/u, "the thumb is placed only after layout");
});

test("liquid glass writes positions through CSSOM only (desktop app:// CSP)", () => {
  const source = readFileSync(new URL("../../src/installLiquidGlass.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/.*$/gmu, "");
  assert.match(source, /style\.setProperty\("--mx"/u);
  assert.doesNotMatch(source, /setAttribute\(\s*["']style|cssText|innerHTML|insertRule|<style/u);
  assert.match(source, /dataset\.motion === "full"/u, "effects run only at full motion");
});
