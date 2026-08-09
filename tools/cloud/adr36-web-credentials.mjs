import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

import { AcceptanceFailure, fail, requireThat } from "./adr36-web-core.mjs";

const MAX_SECRET_BYTES = 16 * 1024;

function exactSecretLine(value) {
  requireThat(
    typeof value === "string" &&
      value.length > 0 &&
      !value.includes("\0") &&
      !value.includes("\n") &&
      !value.includes("\r"),
    "SECRET_VALUE_INVALID",
  );
  return value;
}

export function readProtectedSecretFile(filePath) {
  requireThat(
    typeof filePath === "string" && isAbsolute(filePath) && !filePath.includes("\0"),
    "SECRET_FILE_PATH_INVALID",
  );
  requireThat(Number.isInteger(constants.O_NOFOLLOW), "SECRET_FILE_NOFOLLOW_UNAVAILABLE");
  let descriptor;
  let buffer;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    requireThat(metadata.isFile(), "SECRET_FILE_NOT_REGULAR");
    requireThat((metadata.mode & 0o777) === 0o600, "SECRET_FILE_MODE_INVALID");
    requireThat(metadata.size > 0 && metadata.size <= MAX_SECRET_BYTES, "SECRET_FILE_SIZE_INVALID");
    buffer = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      requireThat(bytes > 0, "SECRET_FILE_READ_INVALID");
      offset += bytes;
    }
    return exactSecretLine(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error;
    fail("SECRET_FILE_INVALID");
  } finally {
    buffer?.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function envSecret(env, name) {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  requireThat(!(direct !== undefined && file !== undefined), "SECRET_SOURCE_AMBIGUOUS");
  requireThat(direct !== undefined || file !== undefined, "SECRET_SOURCE_MISSING");
  return direct !== undefined ? exactSecretLine(direct) : readProtectedSecretFile(file);
}

function loadPrincipal(env, prefix) {
  const principal = Object.freeze({
    username: envSecret(env, `${prefix}_USERNAME`),
    displayName: envSecret(env, `${prefix}_DISPLAY_NAME`),
    password: envSecret(env, `${prefix}_PASSWORD`),
    pin: envSecret(env, `${prefix}_PIN`),
  });
  requireThat(/^[\x21-\x7e]{1,128}$/u.test(principal.username), "CREDENTIAL_FORMAT_INVALID");
  requireThat(
    principal.displayName.trim().length > 0 && principal.displayName.length <= 128,
    "CREDENTIAL_FORMAT_INVALID",
  );
  requireThat(principal.password.length <= 1_024, "CREDENTIAL_FORMAT_INVALID");
  requireThat(/^\d{4,8}$/u.test(principal.pin), "CREDENTIAL_FORMAT_INVALID");
  return principal;
}

export function loadAcceptanceCredentials(env = process.env) {
  const credentials = Object.freeze({
    admin: loadPrincipal(env, "LAUNDRY_BOOTSTRAP_ADMIN"),
    approver: loadPrincipal(env, "LAUNDRY_BOOTSTRAP_APPROVER"),
  });
  requireThat(
    credentials.admin.username !== credentials.approver.username,
    "ADMIN_IDENTITIES_NOT_DISTINCT",
  );
  requireThat(
    credentials.admin.displayName !== credentials.approver.displayName &&
      credentials.admin.password !== credentials.approver.password &&
      credentials.admin.pin !== credentials.approver.pin,
    "ADMIN_CREDENTIALS_NOT_DISTINCT",
  );
  return credentials;
}
