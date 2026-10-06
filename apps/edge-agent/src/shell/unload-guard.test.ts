import assert from "node:assert/strict";
import test from "node:test";
import { LEAVE_ANYWAY, leavesDespiteUnsavedWork } from "./unload-guard.js";

test("a Windows sign-out or shutdown leaves without a blocking question", () => {
  let asked = 0;
  assert.equal(
    leavesDespiteUnsavedWork(true, () => {
      asked++;
      return 0;
    }),
    true,
  );
  assert.equal(asked, 0);
});

test("otherwise the operator decides, and only the explicit choice leaves", () => {
  assert.equal(
    leavesDespiteUnsavedWork(false, () => 0),
    false,
  );
  assert.equal(
    leavesDespiteUnsavedWork(false, () => LEAVE_ANYWAY),
    true,
  );
});
