import assert from "node:assert/strict";
import test from "node:test";

import { followThemeColor, themeBackground } from "./theme-color.js";

test("only #rrggbb theme colours reach the native window background", () => {
  assert.equal(themeBackground("#0c0a14"), "#0c0a14");
  assert.equal(themeBackground("#F3F5F9"), "#F3F5F9");
  for (const rejected of [null, undefined, "", "red", "#fff", "#0c0a14ff", "rgb(0, 0, 0)", 12]) {
    assert.equal(themeBackground(rejected), null, String(rejected));
  }
});

test("the window background follows each valid theme-color change", () => {
  let emit: (color: string | null) => void = () => undefined;
  const applied: string[] = [];
  followThemeColor(
    (listener) => {
      emit = listener;
    },
    { setBackgroundColor: (color) => applied.push(color) },
  );
  emit("#0c0a14");
  emit(null);
  emit("javascript:alert(1)");
  emit("#f3f5f9");
  assert.deepEqual(applied, ["#0c0a14", "#f3f5f9"]);
});
