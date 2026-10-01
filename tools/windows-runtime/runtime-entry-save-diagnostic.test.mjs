import assert from "node:assert/strict";
import test from "node:test";
import {
  captureShortcutSaveDiagnostic,
  parseShortcutSaveDiagnosticOutput,
  shortcutInstallationFailure,
  shortcutSaveDiagnostic,
  shortcutSaveFailureCode,
} from "./runtime-entry-save-diagnostic-fixture.mjs";

const SENTINEL = "PRIVATE_SENTINEL";
const code = "WINDOWS_RUNTIME_ENTRY_SHORTCUT_SAVE_IO_INVALID_NAME_FAILED";
const result = { diagnostic_result: "failed", code };
const native = { exception_type: "System.IO.IOException", hresult: -2147024644, stage: "SAVE" };
const unavailable = {
  diagnostic_result: "unavailable",
  code: "WINDOWS_RUNTIME_ENTRY_DIAGNOSTIC_FAILED",
};
const json = JSON.stringify;
const stderr = (value) => "SHORTCUT_NATIVE_DIAGNOSTIC " + json(value);

test("diagnostic parsing rebuilds only allowlisted result and bounded native fields", () => {
  assert.deepEqual(parseShortcutSaveDiagnosticOutput(json(result), stderr(native)), {
    ...result,
    native,
  });
  assert.deepEqual(parseShortcutSaveDiagnosticOutput('{"diagnostic_result":"succeeded"}', ""), {
    diagnostic_result: "succeeded",
  });
  assert.deepEqual(parseShortcutSaveDiagnosticOutput(json(result), ""), result);
  for (const hresult of [-2147483648, 2147483647])
    assert.equal(
      parseShortcutSaveDiagnosticOutput(json(result), stderr({ ...native, hresult })).native
        .hresult,
      hresult,
    );
});

test("malformed or unexpected stdout and stderr never echo private diagnostic fragments", () => {
  const outputs = [
    [SENTINEL, ""],
    ['{"diagnostic_result":"' + SENTINEL, ""],
    [json({ ...result, private: SENTINEL }), ""],
    [json({ diagnostic_result: SENTINEL, code }), ""],
    [json({ ...result, code: "WINDOWS_RUNTIME_ENTRY_" + SENTINEL }), ""],
    [json(result), SENTINEL],
    [json(result), "SHORTCUT_NATIVE_DIAGNOSTIC " + SENTINEL],
    [json(result), stderr({ ...native, path: SENTINEL })],
    [json(result), stderr({ ...native, stage: SENTINEL })],
    [json(result), stderr({ ...native, exception_type: "System." + SENTINEL })],
    [json(result), stderr({ ...native, stage: "COM_LOAD" })],
    [json(result), stderr(native) + "\n" + SENTINEL],
    ['{"diagnostic_result":"failed","diagnostic_result":"failed","code":"' + code + '"}', ""],
    [json(result), '{"' + SENTINEL + '":1}'],
    [json(result), stderr({ ...native, hresult: 2147483648 })],
    [json(result), stderr({ ...native, hresult: -2147483649 })],
    [json(result), stderr({ ...native, hresult: 1.5 })],
    [json(result), stderr({ ...native, hresult: true })],
    [json(result), stderr({ ...native, hresult: SENTINEL })],
    [SENTINEL.repeat(400), ""],
    [json(result), SENTINEL.repeat(400)],
    [null, ""],
    [json(result), null],
    ['{"diagnostic_result":"succeeded"}', stderr(native)],
  ];
  for (const [stdout, errorOutput] of outputs) {
    const parsed = parseShortcutSaveDiagnosticOutput(stdout, errorOutput);
    assert.deepEqual(parsed, unavailable);
    assert.equal(json(parsed).includes(SENTINEL), false);
  }
});

test("execution and preparation failures return a fixed envelope without error causes", async () => {
  const privateError = new Error(SENTINEL, { cause: new Error(SENTINEL) });
  privateError.stdout = SENTINEL;
  privateError.stderr = SENTINEL;
  assert.deepEqual(
    await captureShortcutSaveDiagnostic(async () => {
      throw privateError;
    }),
    unavailable,
  );
  assert.deepEqual(await captureShortcutSaveDiagnostic(async () => null), unavailable);
  assert.deepEqual(await shortcutSaveDiagnostic(null, null), unavailable);
  assert.deepEqual(await shortcutSaveDiagnostic(null, null, null), unavailable);
});

test("installation diagnostics cannot replace the original stable SAVE failure", async () => {
  assert.equal(shortcutSaveFailureCode(code + "\n"), code);
  assert.equal(
    shortcutSaveFailureCode("WINDOWS_RUNTIME_ENTRY_SHORTCUT_SAVE_" + SENTINEL + "_FAILED"),
    null,
  );
  for (const diagnose of [
    async () => {
      throw new Error(SENTINEL, { cause: new Error(SENTINEL) });
    },
    async () => ({ ...result, private: SENTINEL }),
    async () => ({ ...result, native: { ...native, exception_type: "System." + SENTINEL } }),
    async () => unavailable,
  ]) {
    const failure = await shortcutInstallationFailure(code, diagnose);
    assert.equal(failure.message, code + " SHORTCUT_INSTALL_DIAGNOSTIC " + json(unavailable));
    assert.equal(failure.message.includes(SENTINEL), false);
    assert.equal(failure.cause, undefined);
  }
  const failure = await shortcutInstallationFailure(code, async () => ({ ...result, native }));
  assert.equal(
    failure.message,
    code + " SHORTCUT_INSTALL_DIAGNOSTIC " + json({ ...result, native }),
  );
  assert.equal(failure.cause, undefined);
});
