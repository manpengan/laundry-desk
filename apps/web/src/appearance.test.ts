import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyAppearanceToDocument,
  initialMotionPreference,
  initialPalette,
  motionPreferenceLabel,
  MOTION_STORAGE_KEY,
  paletteKeywords,
  paletteLabel,
  PALETTE_STORAGE_KEY,
  parseMotionPreference,
  parsePalette,
  probeSoftwareRendering,
  resolveMotion,
  syncThemeColor,
  THEME_PALETTES,
  writeStoredMotion,
  writeStoredPalette,
} from "./appearance.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const blocked = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

test("the six palettes match the shipped @laundry/ui themes.css", async () => {
  const css = await readFile(
    new URL("../../../packages/ui/src/styles/themes.css", import.meta.url),
    "utf8",
  );
  const shipped = [...css.matchAll(/^\[data-palette="([a-z]+)"\] \{/gmu)].map((m) => m[1]);
  assert.deepEqual(shipped, [...THEME_PALETTES]);
  assert.deepEqual(THEME_PALETTES.map(paletteLabel), [
    "晴空",
    "海盐",
    "青竹",
    "樱花",
    "暖阳",
    "极光",
  ]);
  assert.match(paletteKeywords("sea"), /haiyan/u);
});

test("system reduce-motion always wins; auto spares software renderers", () => {
  const gpu = { reducedMotion: false, softwareRendering: false };
  const software = { reducedMotion: false, softwareRendering: true };
  const reduced = { reducedMotion: true, softwareRendering: false };
  assert.equal(resolveMotion("auto", gpu), "full");
  assert.equal(resolveMotion("auto", software), "calm");
  assert.equal(resolveMotion("full", software), "full", "an explicit choice is honoured");
  assert.equal(resolveMotion("calm", gpu), "calm");
  assert.equal(resolveMotion("full", reduced), "off");
  assert.equal(resolveMotion("auto", reduced), "off");
  assert.deepEqual((["auto", "full", "calm", "off"] as const).map(motionPreferenceLabel), [
    "自动",
    "标准",
    "节能",
    "关闭",
  ]);
});

test("palette and motion preferences persist per device and survive a blocked store", () => {
  assert.equal(parsePalette("sakura"), "sakura");
  assert.equal(parsePalette("sepia"), null);
  assert.equal(parseMotionPreference("calm"), "calm");
  assert.equal(parseMotionPreference("fast"), null);
  assert.equal(initialPalette(null), "sky");
  assert.equal(initialMotionPreference(null), "auto");
  const storage = memoryStorage();
  writeStoredPalette(storage, "amber");
  writeStoredMotion(storage, "off");
  assert.equal(storage.values.get(PALETTE_STORAGE_KEY), "amber");
  assert.equal(storage.values.get(MOTION_STORAGE_KEY), "off");
  assert.equal(initialPalette(storage), "amber");
  assert.equal(initialMotionPreference(storage), "off");
  storage.values.set(PALETTE_STORAGE_KEY, "neon");
  assert.equal(initialPalette(storage), "sky");
  assert.equal(initialPalette(blocked), "sky");
  assert.doesNotThrow(() => writeStoredPalette(blocked, "sea"));
});

test("the resolved appearance lands on <html> as three data attributes", () => {
  const dataset: Record<string, string> = {};
  applyAppearanceToDocument(
    { documentElement: { dataset } as unknown as HTMLElement },
    {
      theme: "dark",
      palette: "aurora",
      motion: "calm",
    },
  );
  assert.deepEqual(dataset, { theme: "dark", palette: "aurora", motion: "calm" });
});

function fakeDocument(renderer: string | null) {
  return {
    createElement: () => ({
      getContext: () =>
        renderer === null
          ? null
          : {
              getExtension: (name: string) =>
                name === "WEBGL_debug_renderer_info"
                  ? { UNMASKED_RENDERER_WEBGL: 0x9246 }
                  : { loseContext: () => undefined },
              getParameter: () => renderer,
            },
    }),
  } as unknown as Pick<Document, "createElement">;
}

test("software rendering is recognised from the WebGL renderer", () => {
  assert.equal(probeSoftwareRendering(fakeDocument(null)), true, "no GPU context at all");
  assert.equal(
    probeSoftwareRendering(fakeDocument("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))")),
    true,
  );
  assert.equal(
    probeSoftwareRendering(fakeDocument("ANGLE (Microsoft, Microsoft Basic Render Driver)")),
    true,
  );
  assert.equal(
    probeSoftwareRendering(fakeDocument("ANGLE (Intel, Intel(R) Iris(R) Xe Graphics D3D11)")),
    false,
  );
  const throwing = {
    createElement: () => {
      throw new Error("no canvas");
    },
  } as unknown as Pick<Document, "createElement">;
  assert.equal(probeSoftwareRendering(throwing), true);
});

function themeColorDocument(canvas: string) {
  const metas: { name: string; content: string }[] = [];
  const doc = {
    defaultView: { getComputedStyle: () => ({ getPropertyValue: () => canvas }) },
    documentElement: {},
    head: {
      querySelector: () => metas[0] ?? null,
      append: (meta: { name: string; content: string }) => metas.push(meta),
    },
    createElement: () => ({ name: "", content: "" }),
  } as unknown as Document;
  return { doc, metas };
}

test("the painted canvas colour is mirrored into a single theme-color meta", () => {
  const { doc, metas } = themeColorDocument(" #0c0a14 ");
  syncThemeColor(doc);
  syncThemeColor(doc);
  assert.deepEqual(metas, [{ name: "theme-color", content: "#0c0a14" }]);

  const derived = themeColorDocument("color-mix(in srgb, red 5%, blue)");
  syncThemeColor(derived.doc);
  assert.deepEqual(derived.metas, [], "only a literal #rrggbb reaches the window");
});
