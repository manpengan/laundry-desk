import { exactKeys, fail } from "./companion-contract.mjs";
import { requirePortablePassword } from "./portable-crypto.mjs";
import { requireSchedule } from "./schedule-contract.mjs";

export const DATA_ACTIONS = Object.freeze([
  "portable-export",
  "portable-inspect",
  "portable-import",
  "v1-import",
  "export-store",
]);
export const INPUT_ACTIONS = Object.freeze([...DATA_ACTIONS, "backup-schedule"]);

export function requireDataOptions(action, options) {
  const keys =
    action === "export-store"
      ? ["destination", "requestId"]
      : action === "v1-import"
        ? ["requestId"]
        : action === "portable-import"
          ? ["path", "password", "confirmation"]
          : ["path", "password"];
  if (!DATA_ACTIONS.includes(action) || !exactKeys(options, keys)) fail("ARGS_INVALID");
  if (action === "v1-import" || action === "export-store") {
    if (
      typeof options.requestId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        options.requestId,
      )
    )
      fail("ARGS_INVALID");
    if (
      action === "export-store" &&
      (typeof options.destination !== "string" ||
        options.destination.length > 240 ||
        /[\r\n\0]/u.test(options.destination))
    )
      fail("ARGS_INVALID");
  } else {
    if (
      typeof options.path !== "string" ||
      options.path.length > 240 ||
      /[\r\n\0]/u.test(options.path)
    )
      fail("ARGS_INVALID");
    requirePortablePassword(options.password);
    if (
      action === "portable-import" &&
      (typeof options.confirmation !== "string" || !/^[a-f0-9]{64}$/u.test(options.confirmation))
    )
      fail("ARGS_INVALID");
  }
  return options;
}

export async function readDataOptions(action, stream = process.stdin) {
  let size = 0;
  const chunks = [];
  const timeout = setTimeout(
    () => stream.destroy(new Error("WINDOWS_COMPANION_INPUT_TIMEOUT")),
    10000,
  );
  let bytes;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > 8192) fail("ARGS_INVALID");
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
    let value;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      fail("ARGS_INVALID");
    }
    const options =
      value && typeof value === "object" && typeof value.password === "string"
        ? { ...value, password: Buffer.from(value.password, "utf8") }
        : value;
    try {
      return action === "backup-schedule"
        ? requireSchedule(options)
        : requireDataOptions(action, options);
    } catch (error) {
      if (Buffer.isBuffer(options?.password)) options.password.fill(0);
      throw error;
    }
  } finally {
    clearTimeout(timeout);
    for (const chunk of chunks) chunk.fill(0);
    bytes?.fill(0);
  }
}
