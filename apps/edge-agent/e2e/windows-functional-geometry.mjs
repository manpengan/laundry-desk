import assert from "node:assert/strict";

/** @typedef {Readonly<{x: number, y: number, width: number, height: number}>} Rectangle */
/** @typedef {Readonly<{bounds: Rectangle, content: Rectangle, minimum: readonly number[], workArea: Rectangle}>} NativeGeometry */
/** @typedef {Readonly<{innerWidth: number, innerHeight: number}>} RendererSize */

const MINIMUM_RENDERER_WIDTH = 900;
const NORMAL_CONTENT_HEIGHT = 640;
const NATIVE_RENDERER_HEIGHT_TOLERANCE = 1;

/** @param {Rectangle} value @returns {Rectangle} */
function rectangle(value) {
  for (const field of [value.x, value.y, value.width, value.height]) {
    assert.ok(Number.isSafeInteger(field), "WINDOWS_GEOMETRY_INTEGER_REQUIRED");
  }
  assert.ok(value.width > 0 && value.height > 0, "WINDOWS_GEOMETRY_SIZE_INVALID");
  return Object.freeze({ x: value.x, y: value.y, width: value.width, height: value.height });
}

/** @param {NativeGeometry} native @param {RendererSize} renderer */
export function measureAsLaunchedGeometry(native, renderer) {
  const bounds = rectangle(native.bounds);
  const content = rectangle(native.content);
  const workArea = rectangle(native.workArea);
  assert.equal(native.minimum.length, 2, "WINDOWS_GEOMETRY_MINIMUM_SIZE_INVALID");
  const minimumWidth = native.minimum[0];
  const minimumHeight = native.minimum[1];
  assert.ok(typeof minimumWidth === "number" && typeof minimumHeight === "number");
  for (const size of [...native.minimum, renderer.innerWidth, renderer.innerHeight]) {
    assert.ok(Number.isSafeInteger(size) && size >= 0, "WINDOWS_GEOMETRY_SIZE_INVALID");
  }
  assert.ok(renderer.innerWidth > 0 && renderer.innerHeight > 0, "WINDOWS_GEOMETRY_SIZE_INVALID");
  const chromeHeight = bounds.height - content.height;
  const availableContentHeight = workArea.height - chromeHeight;
  assert.ok(chromeHeight >= 0, "WINDOWS_GEOMETRY_CHROME_INVALID");
  assert.ok(availableContentHeight > 0, "WINDOWS_GEOMETRY_WORK_AREA_INVALID");
  /** @type {[number, number]} */
  const minimum = [minimumWidth, minimumHeight];
  return Object.freeze({
    bounds,
    content,
    minimum: Object.freeze(minimum),
    workArea,
    chromeHeight,
    availableContentHeight,
    requiredContentHeight: Math.min(NORMAL_CONTENT_HEIGHT, availableContentHeight),
    renderer: Object.freeze({ innerWidth: renderer.innerWidth, innerHeight: renderer.innerHeight }),
  });
}

/** @param {ReturnType<typeof measureAsLaunchedGeometry>} geometry @returns {void} */
export function assertAsLaunchedGeometry(geometry) {
  assert.ok(
    geometry.renderer.innerWidth >= MINIMUM_RENDERER_WIDTH,
    "WINDOWS_GEOMETRY_WIDTH_TOO_SMALL",
  );
  assert.ok(geometry.bounds.width >= geometry.minimum[0], "WINDOWS_GEOMETRY_NATIVE_MINIMUM_WIDTH");
  assert.ok(
    geometry.bounds.height >= geometry.minimum[1],
    "WINDOWS_GEOMETRY_NATIVE_MINIMUM_HEIGHT",
  );
  assert.ok(
    Math.abs(geometry.renderer.innerHeight - geometry.content.height) <=
      NATIVE_RENDERER_HEIGHT_TOLERANCE,
    "WINDOWS_GEOMETRY_NATIVE_RENDERER_HEIGHT_MISMATCH",
  );
  assert.ok(
    geometry.renderer.innerHeight >= geometry.requiredContentHeight,
    "WINDOWS_GEOMETRY_CONTENT_HEIGHT_TOO_SMALL",
  );
}
