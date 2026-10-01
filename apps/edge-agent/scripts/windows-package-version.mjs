import { readFileSync } from "node:fs";

const VERSION = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/u;

export function parseWindowsPackageVersion(bytes) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 16384)
      throw new Error();
    const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof metadata?.version !== "string" || !VERSION.test(metadata.version)) throw new Error();
    return metadata.version;
  } catch {
    throw new Error("WINDOWS_PROFILE_VERSION_INVALID");
  }
}

export const WINDOWS_PACKAGE_VERSION = parseWindowsPackageVersion(
  readFileSync(new URL("../package.json", import.meta.url)),
);
