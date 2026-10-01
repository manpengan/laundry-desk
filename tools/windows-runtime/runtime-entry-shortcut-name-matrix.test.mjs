import assert from "node:assert/strict";
import test from "node:test";
import {
  parseShortcutNameMatrixOutput,
  shortcutInstallationWithNameMatrix,
  shortcutNameMatrix,
} from "./runtime-entry-shortcut-name-matrix-fixture.mjs";

const cases = ["unicode_clean", "ascii_clean", "unicode_os_context", "ascii_os_context"].map(
  (case_id) => ({
    case_id,
    facts: {
      full_name_equal: true,
      full_name_ignore_case_equal: true,
      parent_exists: true,
      requested_parent_exists: true,
      target_exists: true,
      working_directory_exists: true,
      saved_file_exists: true,
    },
    result: { diagnostic_result: "succeeded" },
    native: null,
  }),
);
const matrix = { cases, os_context_complete: true };
const unavailable = { matrix_result: "unavailable" };
const SENTINEL = "PRIVATE_SENTINEL";

test("filename matrix rebuilds only fixed cases, booleans and existing native diagnostics", () => {
  const parsed = parseShortcutNameMatrixOutput(JSON.stringify(matrix));
  assert.equal(parsed.matrix_result, "complete");
  assert.equal(parsed.os_context_complete, true);
  assert.deepEqual(
    parsed.cases.map(({ case_id }) => case_id),
    cases.map(({ case_id }) => case_id),
  );
  const failed = {
    ...cases[0],
    result: {
      diagnostic_result: "failed",
      code: "WINDOWS_RUNTIME_ENTRY_SHORTCUT_SAVE_IO_FILE_NOT_FOUND_FAILED",
    },
    native: {
      exception_type: "System.IO.FileNotFoundException",
      hresult: -2147024894,
      stage: "SAVE",
    },
  };
  const withFailure = parseShortcutNameMatrixOutput(
    JSON.stringify({ ...matrix, cases: [failed, ...cases.slice(1)] }),
  );
  assert.equal(withFailure.cases[0].report.native.hresult, -2147024894);
});

test("matrix faults and extra fields never echo private paths or exception fragments", async () => {
  const malformed = [
    SENTINEL,
    JSON.stringify({ ...matrix, path: SENTINEL }),
    JSON.stringify({ ...matrix, cases: [{ ...cases[0], case_id: SENTINEL }, ...cases.slice(1)] }),
    JSON.stringify({
      ...matrix,
      cases: [{ ...cases[0], facts: { ...cases[0].facts, path: SENTINEL } }, ...cases.slice(1)],
    }),
    JSON.stringify({
      ...matrix,
      cases: [{ ...cases[0], native: { exception_type: SENTINEL } }, ...cases.slice(1)],
    }),
    JSON.stringify({ ...matrix, os_context_complete: SENTINEL }),
    JSON.stringify({ ...matrix, cases: cases.slice(1) }),
    JSON.stringify(matrix) + SENTINEL,
  ];
  for (const value of malformed) {
    const parsed = parseShortcutNameMatrixOutput(value);
    assert.deepEqual(parsed, unavailable);
    assert.equal(JSON.stringify(parsed).includes(SENTINEL), false);
  }
  assert.deepEqual(await shortcutNameMatrix(null, null), unavailable);
  const failure = await shortcutInstallationWithNameMatrix(
    "WINDOWS_RUNTIME_ENTRY_SHORTCUT_SAVE_IO_FILE_NOT_FOUND_FAILED",
    async () => {
      throw new Error(SENTINEL);
    },
    null,
    null,
  );
  assert.equal(failure.message.includes(SENTINEL), false);
  assert.equal(failure.cause, undefined);
});
