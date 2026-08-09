import { z } from "zod";

import {
  isMacPrinterConnection,
  isValidMacPrinterModel,
  type MacPrinterConnection,
} from "./mac-printer-acceptance.js";
import { assertCanonicalPackagedAppPath } from "./mac-printer-acceptance-artifacts.js";

export type MacPrinterAcceptanceCliArgs = Readonly<{
  originalJobId: string;
  disconnectJobId: string;
  reprintJobId: string;
  printerModel: string;
  connection: MacPrinterConnection;
  appPath: string;
}>;

const ARGUMENTS = Object.freeze({
  "--original-job-id": "originalJobId",
  "--disconnect-job-id": "disconnectJobId",
  "--reprint-job-id": "reprintJobId",
  "--printer-model": "printerModel",
  "--connection": "connection",
  "--app-path": "appPath",
} as const);

function parsePairs(argv: readonly string[]): Record<string, string> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args.length !== Object.keys(ARGUMENTS).length * 2) {
    throw new Error("all printer acceptance arguments are required exactly once");
  }
  let parsed: Readonly<Record<string, string>> = Object.freeze({});
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      !Object.hasOwn(ARGUMENTS, flag) ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error("printer acceptance arguments are invalid");
    }
    const key = ARGUMENTS[flag as keyof typeof ARGUMENTS];
    if (parsed[key] !== undefined) {
      throw new Error("printer acceptance arguments must not be repeated");
    }
    parsed = Object.freeze({ ...parsed, [key]: value });
  }
  return parsed;
}

export function parseMacPrinterAcceptanceArgs(
  argv: readonly string[],
): MacPrinterAcceptanceCliArgs {
  const parsed = parsePairs(argv);
  const originalJobId = parsed.originalJobId!;
  const disconnectJobId = parsed.disconnectJobId!;
  const reprintJobId = parsed.reprintJobId!;
  const printerModel = parsed.printerModel!;
  const connection = parsed.connection!;
  const appPath = parsed.appPath!;
  const jobIds = [originalJobId, disconnectJobId, reprintJobId];
  if (jobIds.some((jobId) => !z.uuid().safeParse(jobId).success)) {
    throw new Error("printer acceptance job identifiers must be UUIDs");
  }
  if (new Set(jobIds).size !== jobIds.length) {
    throw new Error("printer acceptance job identifiers must be distinct");
  }
  if (!isValidMacPrinterModel(printerModel)) {
    throw new Error("printer model must be 1-80 trimmed characters without controls");
  }
  if (!isMacPrinterConnection(connection)) throw new Error("printer connection is invalid");
  assertCanonicalPackagedAppPath(appPath);
  return Object.freeze({
    originalJobId,
    disconnectJobId,
    reprintJobId,
    printerModel,
    connection,
    appPath,
  });
}
