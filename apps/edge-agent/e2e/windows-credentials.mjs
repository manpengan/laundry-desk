import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { inspectPrivateDirectory, inspectPrivateFile } from "@laundry/platform-fs";

const INVALID = "Windows Runtime credential handoff is invalid";
const MAXIMUM_BYTES = 8192;
const COMPANION_DIRECTORY = "LAUNDRY_WINDOWS_RUNTIME_SECRETS_DIR";
const LEGACY_FILE = "LAUNDRY_WINDOWS_RUNTIME_CREDENTIALS_FILE";

/** @typedef {Readonly<Record<string, string | undefined>>} CredentialEnvironment */
/** @typedef {Readonly<{kind: "companion" | "legacy", path: string, privateRoot: string}>} CredentialSource */

function invalid() {
  return new Error(INVALID);
}

/** @param {string} value */
function absolutePath(value) {
  if (value !== value.trim() || !isAbsolute(value) || value.includes("\0")) throw invalid();
  return resolve(value);
}

/** @param {string} path */
async function privateDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw invalid();
  await inspectPrivateDirectory(path);
  const canonical = await realpath(path);
  const normalize =
    process.platform === "win32"
      ? (/** @type {string} */ value) => value.toLowerCase()
      : (/** @type {string} */ value) => value;
  if (normalize(canonical) !== normalize(resolve(path))) throw invalid();
  return canonical;
}

/** @param {CredentialEnvironment} environment @returns {Promise<CredentialSource>} */
async function credentialSource(environment) {
  const companion = environment[COMPANION_DIRECTORY];
  const legacy = environment[LEGACY_FILE];
  if ((companion === undefined) === (legacy === undefined)) throw invalid();
  if (companion !== undefined) {
    const path = await privateDirectory(absolutePath(companion));
    return Object.freeze({ kind: "companion", path, privateRoot: path });
  }
  if (legacy === undefined) throw invalid();
  const path = absolutePath(legacy);
  const privateRoot = await privateDirectory(dirname(path));
  return Object.freeze({ kind: "legacy", path, privateRoot });
}

/** @param {import("node:fs").Stats} metadata */
function regularBoundedFile(metadata) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size < 1 ||
    metadata.size > MAXIMUM_BYTES
  )
    throw invalid();
}

/** @param {import("node:fs").Stats} before @param {import("node:fs").Stats} after */
function unchangedFile(before, after) {
  regularBoundedFile(after);
  if (
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.size !== after.size ||
    before.ctimeMs !== after.ctimeMs ||
    before.mtimeMs !== after.mtimeMs
  )
    throw invalid();
}

/** @param {string} path */
async function readPrivateText(path) {
  await inspectPrivateFile(path);
  const before = await lstat(path);
  regularBoundedFile(before);
  const handle = await open(path, "r");
  const buffer = Buffer.alloc(MAXIMUM_BYTES + 1);
  try {
    unchangedFile(before, await handle.stat());
    let length = 0;
    while (length < buffer.length) {
      const chunk = await handle.read(buffer, length, buffer.length - length, length);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    if (length !== before.size || length > MAXIMUM_BYTES) throw invalid();
    unchangedFile(before, await lstat(path));
    await inspectPrivateFile(path);
    unchangedFile(before, await handle.stat());
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    buffer.fill(0);
    await handle.close();
  }
}

/** @param {CredentialSource} source @param {boolean} full @returns {Promise<Readonly<Record<string, unknown>>>} */
async function credentialValues(source, full) {
  if (source.kind === "legacy") {
    const record = credentialRecord(await readPrivateText(source.path));
    if (record.development_only !== true) throw invalid();
    return record;
  }
  const names = full
    ? [
        "admin_username",
        "admin_display_name",
        "admin_password",
        "admin_pin",
        "approver_display_name",
        "approver_pin",
      ]
    : ["admin_username", "admin_display_name", "admin_password"];
  return Object.freeze(
    Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [
          name,
          await readPrivateText(
            join(source.path, `laundry-bootstrap-${name.replaceAll("_", "-")}`),
          ),
        ]),
      ),
    ),
  );
}

/** @param {string} contents @returns {Readonly<Record<string, unknown>>} */
function credentialRecord(contents) {
  /** @type {unknown} */
  const value = JSON.parse(contents);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return /** @type {Readonly<Record<string, unknown>>} */ (value);
}

/** @param {Readonly<Record<string, unknown>>} values @param {string} name @param {"username" | "displayName" | "password" | "pin"} format */
function credential(values, name, format) {
  const value = values[name];
  if (typeof value !== "string" || /[\0\r\n]/u.test(value)) throw invalid();
  if (format === "username" && !/^[A-Za-z0-9_.-]{1,64}$/u.test(value)) throw invalid();
  if (format === "displayName" && (value.trim().length < 1 || value.length > 80)) throw invalid();
  if (format === "password" && (value.length < 12 || value.length > 256)) throw invalid();
  if (format === "pin" && !/^\d{6,8}$/u.test(value)) throw invalid();
  return value;
}

/** @param {CredentialEnvironment} [environment] */
export async function loadWindowsRuntimeCredentials(environment = process.env) {
  try {
    const source = await credentialSource(environment);
    const values = await credentialValues(source, false);
    return Object.freeze({
      privateRoot: source.privateRoot,
      adminUsername: credential(values, "admin_username", "username"),
      adminDisplayName: credential(values, "admin_display_name", "displayName"),
      adminPassword: credential(values, "admin_password", "password"),
    });
  } catch {
    // JSON/parser and filesystem errors can contain a secret or private path.
    throw invalid();
  }
}

/** @param {CredentialEnvironment} [environment] */
export async function loadWindowsBootstrapCredentials(environment = process.env) {
  try {
    const source = await credentialSource(environment);
    const values = await credentialValues(source, true);
    const adminPin = credential(values, "admin_pin", "pin");
    const approverPin = credential(values, "approver_pin", "pin");
    if (adminPin === approverPin) throw invalid();
    return Object.freeze({
      privateRoot: source.privateRoot,
      adminUsername: credential(values, "admin_username", "username"),
      adminDisplayName: credential(values, "admin_display_name", "displayName"),
      adminPassword: credential(values, "admin_password", "password"),
      adminPin,
      approverDisplayName: credential(values, "approver_display_name", "displayName"),
      approverPin,
    });
  } catch {
    throw invalid();
  }
}

/** @param {string} path */
export async function loadWindowsFunctionalAccount(path) {
  try {
    await lstat(absolutePath(path));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw invalid();
  }
  try {
    const values = credentialRecord(await readPrivateText(path));
    if (
      values.development_only !== true ||
      values.org_code !== "local" ||
      values.store_code !== "main" ||
      values.role !== "admin" ||
      values.privacy_admin !== false
    )
      throw invalid();
    return Object.freeze({
      username: credential(values, "username", "username"),
      displayName: credential(values, "display_name", "displayName"),
      password: credential(values, "password", "password"),
      pin: credential(values, "pin", "pin"),
    });
  } catch {
    throw invalid();
  }
}

/** @param {Pick<import("@playwright/test").Locator, "fill">} input @param {string} value */
export async function fillWindowsCredential(input, value) {
  try {
    await input.fill(value);
  } catch {
    // Playwright action errors can include the value supplied to fill().
    throw new Error("Windows credential input is unavailable");
  }
}
