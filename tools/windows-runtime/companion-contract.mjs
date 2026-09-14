import { createHash } from "node:crypto";

export const MANIFEST_NAME = "runtime-payload.json";
export const MAX_FILES = 20000;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const SHA = /^[0-9a-f]{64}$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[a-z0-9.-]+)?$/u;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function fail(code) {
  throw new Error(`WINDOWS_COMPANION_${code}`);
}

export function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...keys].sort());
}

export function requirePayloadPath(value) {
  if (typeof value !== "string" || value.length > 240 || value.length === 0) fail("PATH_INVALID");
  for (const segment of value.split("/")) {
    if (
      !/^[A-Za-z0-9@_.+ ()-]+$/u.test(segment) ||
      segment === "." ||
      segment === ".." ||
      /[. ]$/u.test(segment) ||
      RESERVED.test(segment) ||
      segment.toLowerCase() === ".git" ||
      /^\.env(?:\.|$)/iu.test(segment)
    )
      fail("PATH_INVALID");
  }
  return value;
}

export const REQUIRED_FILES = Object.freeze([
  "node/node.exe",
  "node/LICENSE",
  "postgres/bin/postgres.exe",
  "postgres/bin/initdb.exe",
  "postgres/bin/pg_ctl.exe",
  "postgres/bin/psql.exe",
  "postgres/bin/createdb.exe",
  "postgres/server_license.txt",
  "server/package.json",
  "server/dist/runtime/kit-entrypoint.js",
  "server/node_modules/@laundry/platform-fs/native/windows/laundry-windows-helper.exe",
  "server/node_modules/@laundry/platform-fs/native/windows/laundry-windows-helper.exe.sha256",
  "metadata/contracts.json",
  "metadata/schema.md",
  "scripts/companion-contract.mjs",
  "scripts/companion-files.mjs",
  "scripts/inspect-companion.mjs",
  "scripts/smoke-companion.mjs",
  "scripts/lifecycle-cli.mjs",
  "scripts/lifecycle.mjs",
  "scripts/lifecycle-storage.mjs",
  "scripts/lifecycle-environment.mjs",
  "scripts/lifecycle-process.mjs",
  "scripts/lifecycle-database.mjs",
  "scripts/lifecycle-release.mjs",
  "scripts/lifecycle-host.ps1",
  "scripts/lifecycle-launch.ps1",
]);

export function requireManifest(value) {
  if (
    !exactKeys(value, [
      "schema",
      "version",
      "assurance",
      "platform",
      "source_git_sha",
      "runtime_release",
      "sources",
      "migration_head",
      "migrations_sha256",
      "files",
    ]) ||
    value.schema !== "laundry.windows.runtime-payload" ||
    value.version !== 1 ||
    value.assurance !== "development_only" ||
    value.platform !== "win32-x64" ||
    typeof value.source_git_sha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.source_git_sha) ||
    typeof value.runtime_release !== "string" ||
    !VERSION.test(value.runtime_release) ||
    typeof value.migration_head !== "string" ||
    !/^\d{4}_[a-z0-9_]+\.sql$/u.test(value.migration_head) ||
    typeof value.migrations_sha256 !== "string" ||
    !SHA.test(value.migrations_sha256) ||
    !exactKeys(value.sources, ["node", "postgres"]) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > MAX_FILES
  )
    fail("MANIFEST_INVALID");
  for (const name of ["node", "postgres"]) {
    const source = value.sources[name];
    if (
      !exactKeys(source, ["version", "url", "sha256"]) ||
      typeof source.version !== "string" ||
      typeof source.sha256 !== "string" ||
      !SHA.test(source.sha256) ||
      typeof source.url !== "string"
    )
      fail("MANIFEST_INVALID");
    const expectedUrl =
      name === "node"
        ? `https://nodejs.org/dist/v${source.version}/node-v${source.version}-win-x64.zip`
        : `https://get.enterprisedb.com/postgresql/postgresql-${source.version}-3-windows-x64-binaries.zip`;
    if (
      (name === "node"
        ? !/^22\.\d+\.\d+$/u.test(source.version)
        : !/^16\.\d+$/u.test(source.version)) ||
      source.url !== expectedUrl
    )
      fail("MANIFEST_INVALID");
  }
  const names = new Set();
  let previous = "";
  let total = 0;
  for (const entry of value.files) {
    if (
      !exactKeys(entry, ["path", "size", "sha256"]) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > MAX_FILE_BYTES ||
      typeof entry.sha256 !== "string" ||
      !SHA.test(entry.sha256)
    )
      fail("MANIFEST_INVALID");
    requirePayloadPath(entry.path);
    const name = entry.path.toLowerCase();
    if (entry.path === MANIFEST_NAME || entry.path <= previous || names.has(name))
      fail("FILE_SET_INVALID");
    names.add(name);
    previous = entry.path;
    total += entry.size;
  }
  if (total > MAX_PAYLOAD_BYTES) fail("PAYLOAD_TOO_LARGE");
  for (const name of names) {
    const segments = name.split("/");
    segments.pop();
    while (segments.length) {
      if (names.has(segments.join("/"))) fail("FILE_SET_INVALID");
      segments.pop();
    }
  }
  if (
    [...REQUIRED_FILES, `migrations/${value.migration_head}`].some(
      (name) => !value.files.some((entry) => entry.path === name),
    )
  )
    fail("REQUIRED_FILE_MISSING");
  return value;
}

export function canonicalManifest(value) {
  requireManifest(value);
  function ordered(item) {
    if (Array.isArray(item)) return item.map(ordered);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, ordered(item[key])]),
      );
    }
    return item;
  }
  return `${JSON.stringify(ordered(value), null, 2)}\n`;
}

export function parseManifest(bytes, expectedDigest) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > MAX_MANIFEST_BYTES ||
    typeof expectedDigest !== "string" ||
    !SHA.test(expectedDigest) ||
    digest(bytes) !== expectedDigest
  ) {
    fail("MANIFEST_DIGEST_INVALID");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("MANIFEST_JSON_INVALID");
  }
  requireManifest(value);
  if (!bytes.equals(Buffer.from(canonicalManifest(value)))) fail("MANIFEST_NOT_CANONICAL");
  return value;
}
