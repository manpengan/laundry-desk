import assert from "node:assert/strict";
import test from "node:test";
import {
  measureAsLaunchedGeometry,
  assertAsLaunchedGeometry,
} from "../e2e/windows-functional-geometry.mjs";

function geometry(outerHeight, contentHeight, workAreaHeight, minimumHeight = 0) {
  return measureAsLaunchedGeometry(
    {
      bounds: { x: 20, y: 20, width: 960, height: outerHeight },
      content: { x: 20, y: 55, width: 944, height: contentHeight },
      minimum: [0, minimumHeight],
      workArea: { x: 0, y: 0, width: 1280, height: workAreaHeight },
    },
    { innerWidth: 944, innerHeight: contentHeight },
  );
}

test("an ample work area retains the full 640 content height requirement", () => {
  const adequate = geometry(675, 640, 800);
  assert.equal(adequate.requiredContentHeight, 640);
  assertAsLaunchedGeometry(adequate);
  assert.throws(() => assertAsLaunchedGeometry(geometry(674, 639, 800)), {
    message: "WINDOWS_GEOMETRY_CONTENT_HEIGHT_TOO_SMALL",
  });
});

test("a constrained work area requires its available height after native window chrome", () => {
  const constrained = geometry(650, 615, 650);
  assert.equal(constrained.chromeHeight, 35);
  assert.equal(constrained.availableContentHeight, 615);
  assert.equal(constrained.requiredContentHeight, 615);
  assertAsLaunchedGeometry(constrained);
});

test("a constrained display does not allow the window to be additionally shortened", () => {
  const shortened = geometry(640, 605, 650);
  assert.equal(shortened.requiredContentHeight, 615);
  assert.throws(() => assertAsLaunchedGeometry(shortened), {
    message: "WINDOWS_GEOMETRY_CONTENT_HEIGHT_TOO_SMALL",
  });
});

test("available content space cannot override the actual native minimum size", () => {
  assert.throws(() => assertAsLaunchedGeometry(geometry(690, 655, 900, 700)), {
    message: "WINDOWS_GEOMETRY_NATIVE_MINIMUM_HEIGHT",
  });
});
