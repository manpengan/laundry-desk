import assert from "node:assert/strict";
import test from "node:test";

import { parseMacPrinterAcceptanceArgs } from "./mac-printer-acceptance-cli-args.js";

const VALID_ARGS = Object.freeze([
  "--original-job-id",
  "936da01f-9abd-4d9d-80c7-02af85c822a8",
  "--disconnect-job-id",
  "cb3b00b5-e6fc-45da-a565-895819118e92",
  "--reprint-job-id",
  "a7ef3809-f73d-44ad-aeda-326faa476921",
  "--printer-model",
  "Xprinter XP-58IIH",
  "--connection",
  "usb",
  "--app-path",
  "/Applications/laundry-desk V2.app",
]);

function replaceArgument(flag: string, value: string): readonly string[] {
  return VALID_ARGS.map((entry, index) => (VALID_ARGS[index - 1] === flag ? value : entry));
}

test("formal CLI accepts every required argument once in any order", () => {
  assert.deepEqual(parseMacPrinterAcceptanceArgs(VALID_ARGS), {
    originalJobId: "936da01f-9abd-4d9d-80c7-02af85c822a8",
    disconnectJobId: "cb3b00b5-e6fc-45da-a565-895819118e92",
    reprintJobId: "a7ef3809-f73d-44ad-aeda-326faa476921",
    printerModel: "Xprinter XP-58IIH",
    connection: "usb",
    appPath: "/Applications/laundry-desk V2.app",
  });
  const reordered = Object.freeze(["--", ...VALID_ARGS.slice(10), ...VALID_ARGS.slice(0, 10)]);
  assert.equal(
    parseMacPrinterAcceptanceArgs(reordered).appPath,
    "/Applications/laundry-desk V2.app",
  );
});

test("formal CLI rejects missing, duplicate, unknown, and value-less arguments", () => {
  const cases = [
    VALID_ARGS.slice(0, -2),
    [...VALID_ARGS.slice(0, -2), "--connection", "ethernet"],
    [...VALID_ARGS.slice(0, -2), "--not-supported", "value"],
    replaceArgument("--printer-model", "--connection"),
  ];
  for (const argv of cases) assert.throws(() => parseMacPrinterAcceptanceArgs(argv));
});

test("formal CLI validates UUIDs, model, connection, and canonical app path", () => {
  const repeatedJob = replaceArgument(
    "--disconnect-job-id",
    "936da01f-9abd-4d9d-80c7-02af85c822a8",
  );
  const cases = [
    replaceArgument("--original-job-id", "not-a-uuid"),
    repeatedJob,
    replaceArgument("--printer-model", ""),
    replaceArgument("--printer-model", `XP58\nsecret`),
    replaceArgument("--printer-model", `XP58\u2028secret`),
    replaceArgument("--printer-model", "x".repeat(81)),
    replaceArgument("--connection", "bluetooth"),
    replaceArgument("--app-path", "release/laundry.app"),
    replaceArgument("--app-path", "/Applications/laundry-desk"),
    replaceArgument("--app-path", "/Applications/../Applications/laundry.app"),
  ];
  for (const argv of cases) assert.throws(() => parseMacPrinterAcceptanceArgs(argv));
});

test("formal CLI validation errors never reflect invalid caller values", () => {
  const supplied = "secret-invalid-value";
  assert.throws(
    () => parseMacPrinterAcceptanceArgs(replaceArgument("--original-job-id", supplied)),
    (error: unknown) => error instanceof Error && !error.message.includes(supplied),
  );
});
