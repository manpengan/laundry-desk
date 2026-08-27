import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_CLOUD_ENVIRONMENT_PROFILE } from "./cloud-environment-profile.mjs";
import { fail } from "./hk-vps-release-core.mjs";
import { readPrivateFile, writeOrVerifyPrivateFile } from "./hk-vps-release-private-file.mjs";

export const ACCEPTANCE_SECRET_ROOT = DEFAULT_CLOUD_ENVIRONMENT_PROFILE.paths.acceptanceSecretRoot;
export const ACCEPTANCE_ENV_PATH =
  DEFAULT_CLOUD_ENVIRONMENT_PROFILE.paths.acceptanceEnvironmentFile;
export const SERVER_ENV_PATH = DEFAULT_CLOUD_ENVIRONMENT_PROFILE.paths.serverEnvironmentFile;
export const ACCEPTANCE_FIXTURE_OPT_IN = "APPLY_SYNTHETIC_HISTORY_ON_HK_VPS";

const MAX_SECRET_BYTES = 16 * 1024;
const MAX_ENV_BYTES = 64 * 1024;

export const ACCEPTANCE_CREDENTIAL_FILES = Object.freeze([
  Object.freeze({
    env: "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME_FILE",
    filename: "admin-username",
    source: "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME",
  }),
  Object.freeze({
    env: "LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME_FILE",
    filename: "admin-display-name",
    source: "LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME",
  }),
  Object.freeze({
    env: "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD_FILE",
    filename: "admin-password",
    source: "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD",
  }),
  Object.freeze({
    env: "LAUNDRY_BOOTSTRAP_ADMIN_PIN_FILE",
    filename: "admin-pin",
    source: "LAUNDRY_BOOTSTRAP_ADMIN_PIN",
  }),
  Object.freeze({
    env: "LAUNDRY_BOOTSTRAP_APPROVER_USERNAME_FILE",
    filename: "approver-username",
    source: "LAUNDRY_BOOTSTRAP_APPROVER_USERNAME_FILE",
  }),
  Object.freeze({
    env: "LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME_FILE",
    filename: "approver-display-name",
    source: "LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME_FILE",
  }),
  Object.freeze({
    env: "LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD_FILE",
    filename: "approver-password",
    source: "LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD_FILE",
  }),
  Object.freeze({
    env: "LAUNDRY_BOOTSTRAP_APPROVER_PIN_FILE",
    filename: "approver-pin",
    source: "LAUNDRY_BOOTSTRAP_APPROVER_PIN_FILE",
  }),
]);

const DATABASE_SECRET = Object.freeze({
  env: "LAUNDRY_ADR36_DATABASE_ADMIN_URL_FILE",
  filename: "database-admin-url",
  source: "DATABASE_ADMIN_URL",
});

function exactSecret(value, code) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES ||
    /[\0\r\n]/u.test(value)
  ) {
    fail(code);
  }
  return value;
}

function parseEnvironmentValue(source) {
  const input = source.trim();
  let mode = "plain";
  let value = "";
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (mode === "single") {
      if (character === "'") mode = "plain";
      else value += character;
      continue;
    }
    if (mode === "double") {
      if (character === '"') {
        mode = "plain";
      } else if (character === "\\") {
        const next = input[index + 1];
        if (next === undefined) fail("CLOUD_RELEASE_SERVER_ENV_INVALID");
        if ('\\"$`'.includes(next)) {
          value += next;
          index += 1;
        } else {
          value += `\\${next}`;
          index += 1;
        }
      } else {
        value += character;
      }
      continue;
    }
    if (character === "'") mode = "single";
    else if (character === '"') mode = "double";
    else if (character === "\\") {
      const next = input[index + 1];
      if (next === undefined) fail("CLOUD_RELEASE_SERVER_ENV_INVALID");
      value += next;
      index += 1;
    } else value += character;
  }
  if (mode !== "plain") fail("CLOUD_RELEASE_SERVER_ENV_INVALID");
  return exactSecret(value, "CLOUD_RELEASE_SERVER_ENV_INVALID");
}

export function parseServerEnvironment(source) {
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    Buffer.byteLength(source, "utf8") > MAX_ENV_BYTES ||
    source.includes("\0") ||
    source.includes("\r")
  ) {
    fail("CLOUD_RELEASE_SERVER_ENV_INVALID");
  }
  const environment = new Map();
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (match === null || environment.has(match[1])) fail("CLOUD_RELEASE_SERVER_ENV_INVALID");
    environment.set(match[1], parseEnvironmentValue(match[2]));
  }
  return environment;
}

async function requireExactDirectory(path, uid, gid, mode, code) {
  const metadata = await lstat(path).catch(() => null);
  const canonical = metadata === null ? null : await realpath(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.mode & 0o7777) !== mode ||
    canonical !== path
  ) {
    fail(code);
  }
}

function canonicalAcceptanceEnvironment(secretRoot = ACCEPTANCE_SECRET_ROOT) {
  const rows = [
    ...ACCEPTANCE_CREDENTIAL_FILES.map((item) => `${item.env}=${join(secretRoot, item.filename)}`),
    `${DATABASE_SECRET.env}=${join(secretRoot, DATABASE_SECRET.filename)}`,
    `LAUNDRY_ADR36_REMINDER_FIXTURE=${ACCEPTANCE_FIXTURE_OPT_IN}`,
  ];
  return `${rows.join("\n")}\n`;
}

async function sourceSecret(environment, item, uid, gid) {
  const value = environment.get(item.source);
  if (value === undefined) fail("CLOUD_RELEASE_ACCEPTANCE_SECRET_SOURCE_MISSING");
  if (item.source.endsWith("_FILE")) {
    return exactSecret(
      await readPrivateFile(value, {
        code: "CLOUD_RELEASE_ACCEPTANCE_SECRET_SOURCE_INVALID",
        gid,
        maximumBytes: MAX_SECRET_BYTES,
        uid,
      }),
      "CLOUD_RELEASE_ACCEPTANCE_SECRET_SOURCE_INVALID",
    );
  }
  return exactSecret(value, "CLOUD_RELEASE_ACCEPTANCE_SECRET_SOURCE_INVALID");
}

export async function materializeAcceptanceSecrets(options = {}) {
  const uid = options.uid ?? 0;
  const gid = options.gid ?? 0;
  const sourcePath = options.sourcePath ?? SERVER_ENV_PATH;
  const secretRoot = options.secretRoot ?? ACCEPTANCE_SECRET_ROOT;
  const envPath = options.envPath ?? ACCEPTANCE_ENV_PATH;
  const source = await readPrivateFile(sourcePath, {
    code: "CLOUD_RELEASE_SERVER_ENV_INVALID",
    gid,
    maximumBytes: MAX_ENV_BYTES,
    uid,
  });
  const environment = parseServerEnvironment(source);
  const forbidden = [
    ...ACCEPTANCE_CREDENTIAL_FILES.flatMap((item) => {
      const direct = item.env.slice(0, -5);
      return item.source.endsWith("_FILE") ? [direct] : [item.env];
    }),
    "DATABASE_ADMIN_URL_FILE",
  ];
  if (forbidden.some((name) => environment.has(name))) {
    fail("CLOUD_RELEASE_ACCEPTANCE_SECRET_SOURCE_AMBIGUOUS");
  }
  const values = [];
  for (const item of [...ACCEPTANCE_CREDENTIAL_FILES, DATABASE_SECRET]) {
    values.push(Object.freeze({ item, value: await sourceSecret(environment, item, uid, gid) }));
  }
  await mkdir(secretRoot, { mode: 0o700 }).catch((error) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
  await requireExactDirectory(
    secretRoot,
    uid,
    gid,
    0o700,
    "CLOUD_RELEASE_ACCEPTANCE_SECRET_ROOT_INVALID",
  );
  for (const { item, value } of values) {
    await writeOrVerifyPrivateFile(join(secretRoot, item.filename), value, {
      code: "CLOUD_RELEASE_ACCEPTANCE_SECRET_FILE_INVALID",
      gid,
      maximumBytes: MAX_SECRET_BYTES,
      mismatchCode: "CLOUD_RELEASE_ACCEPTANCE_SECRET_MISMATCH",
      uid,
    });
  }
  await writeOrVerifyPrivateFile(envPath, canonicalAcceptanceEnvironment(secretRoot), {
    code: "CLOUD_RELEASE_ACCEPTANCE_ENV_INVALID",
    gid,
    maximumBytes: MAX_ENV_BYTES,
    mismatchCode: "CLOUD_RELEASE_ACCEPTANCE_SECRET_MISMATCH",
    uid,
  });
  return await loadRemoteAcceptanceEnvironment({ envPath, gid, secretRoot, uid });
}

export async function loadRemoteAcceptanceEnvironment(options = {}) {
  const uid = options.uid ?? 0;
  const gid = options.gid ?? 0;
  const secretRoot = options.secretRoot ?? ACCEPTANCE_SECRET_ROOT;
  const envPath = options.envPath ?? ACCEPTANCE_ENV_PATH;
  await requireExactDirectory(
    secretRoot,
    uid,
    gid,
    0o700,
    "CLOUD_RELEASE_ACCEPTANCE_SECRET_ROOT_INVALID",
  );
  const expectedFiles = [...ACCEPTANCE_CREDENTIAL_FILES, DATABASE_SECRET]
    .map((item) => item.filename)
    .sort();
  const actualFiles = (await readdir(secretRoot)).sort();
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((filename, index) => filename !== expectedFiles[index])
  ) {
    fail("CLOUD_RELEASE_ACCEPTANCE_SECRET_ROOT_INVALID");
  }
  const source = await readPrivateFile(envPath, {
    code: "CLOUD_RELEASE_ACCEPTANCE_ENV_INVALID",
    gid,
    maximumBytes: MAX_ENV_BYTES,
    uid,
  });
  if (source !== canonicalAcceptanceEnvironment(secretRoot)) {
    fail("CLOUD_RELEASE_ACCEPTANCE_ENV_INVALID");
  }
  for (const item of [...ACCEPTANCE_CREDENTIAL_FILES, DATABASE_SECRET]) {
    exactSecret(
      await readPrivateFile(join(secretRoot, item.filename), {
        code: "CLOUD_RELEASE_ACCEPTANCE_SECRET_FILE_INVALID",
        gid,
        maximumBytes: MAX_SECRET_BYTES,
        uid,
      }),
      "CLOUD_RELEASE_ACCEPTANCE_SECRET_FILE_INVALID",
    );
  }
  return Object.freeze({
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/opt/nodejs/bin:/usr/bin:/bin",
    ...Object.fromEntries(
      [...ACCEPTANCE_CREDENTIAL_FILES, DATABASE_SECRET].map((item) => [
        item.env,
        join(secretRoot, item.filename),
      ]),
    ),
    LAUNDRY_ADR36_REMINDER_FIXTURE: ACCEPTANCE_FIXTURE_OPT_IN,
  });
}

export function assertNoDirectAcceptanceSecrets(environment) {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    fail("CLOUD_RELEASE_ENVIRONMENT_INVALID");
  }
  for (const name of Object.keys(environment)) {
    if (name.startsWith("LAUNDRY_BOOTSTRAP_") && !name.endsWith("_FILE")) {
      fail("CLOUD_RELEASE_DIRECT_SECRET_REJECTED");
    }
  }
}
