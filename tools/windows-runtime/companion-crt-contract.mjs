import { createHash } from "node:crypto";
import { CRT_DLLS, CRT_LICENSE, CRT_SOURCE } from "./companion-crt-source.mjs";

export const CRT_METADATA_NAME = "metadata/windows-crt.json";
export const CRT_LICENSE_NAME = "metadata/licenses/microsoft-visual-cpp.rtf";
export const CRT_TARGET_DIRECTORIES = Object.freeze([
  "postgres/bin",
  "server/node_modules/@node-rs/argon2-win32-x64-msvc",
]);
const names = Object.freeze(CRT_DLLS.map(({ name }) => name));
const shaPattern = /^[a-f0-9]{64}$/u;
const versionPattern = /^14\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const sourceUrl =
  /^https:\/\/download\.visualstudio\.microsoft\.com\/download\/pr\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/[a-fA-F0-9]{64}\/VC_redist\.x64\.exe$/u;
const dllPaths = Object.freeze(
  CRT_TARGET_DIRECTORIES.flatMap((directory) => names.map((name) => `${directory}/${name}`)),
);
const paths = Object.freeze([...dllPaths, CRT_METADATA_NAME, CRT_LICENSE_NAME]);
const knownPaths = new Set(paths.map((path) => path.toLowerCase()));

export function crtFailure(code) {
  throw new Error(`WINDOWS_COMPANION_CRT_${code}`);
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sizeValid = (value, limit) => Number.isSafeInteger(value) && value > 0 && value <= limit;
const shaValid = (value) => typeof value === "string" && shaPattern.test(value);
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

function canonical(value) {
  function ordered(item) {
    if (Array.isArray(item)) return item.map(ordered);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, ordered(item[key])]),
      );
    return item;
  }
  return Buffer.from(`${JSON.stringify(ordered(value), null, 2)}\n`);
}

export function createCrtMetadataBytes() {
  return canonical({
    schema: "laundry.windows.crt-dependencies",
    version: 1,
    platform: "win32-x64",
    source: CRT_SOURCE,
    files: CRT_DLLS.map((file) => ({
      ...file,
      version: CRT_SOURCE.version,
      destinations: CRT_TARGET_DIRECTORIES.map((directory) => `${directory}/${file.name}`),
    })),
    license: { ...CRT_LICENSE, path: CRT_LICENSE_NAME },
  });
}

export function crtPayloadEntries() {
  const metadata = createCrtMetadataBytes();
  return [
    ...CRT_TARGET_DIRECTORIES.flatMap((directory) =>
      CRT_DLLS.map(({ name, size, sha256 }) => ({ path: `${directory}/${name}`, size, sha256 })),
    ),
    { path: CRT_LICENSE_NAME, size: CRT_LICENSE.size, sha256: CRT_LICENSE.sha256 },
    { path: CRT_METADATA_NAME, size: metadata.length, sha256: digest(metadata) },
  ].sort((a, b) => (a.path < b.path ? -1 : 1));
}

function recognized(path) {
  if (typeof path !== "string") crtFailure("MANIFEST_INVALID");
  const lower = path.toLowerCase().replaceAll("\\", "/");
  const leaf = lower.split("/").at(-1);
  return (
    knownPaths.has(lower) ||
    names.includes(leaf) ||
    ["windows-crt.json", "microsoft-visual-cpp.rtf"].includes(leaf)
  );
}

// Published cohorts retain their own hashes/versions; current build pins are not
// a runtime allowlist. This permits rollback to another complete schema-1 cohort.
export function requireCrtManifestFiles(files) {
  if (!Array.isArray(files)) crtFailure("MANIFEST_INVALID");
  const cohort = files.filter((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) crtFailure("MANIFEST_INVALID");
    return recognized(entry.path);
  });
  if (cohort.length === 0) return false;
  if (cohort.length !== paths.length) crtFailure("CAPABILITY_INCOMPLETE");
  const entries = new Map();
  for (const entry of cohort) {
    const limit = entry.path === CRT_METADATA_NAME ? 65536 : 512 * 1024 * 1024;
    if (
      !exactKeys(entry, ["path", "size", "sha256"]) ||
      !paths.includes(entry.path) ||
      entries.has(entry.path) ||
      !sizeValid(entry.size, limit) ||
      !shaValid(entry.sha256)
    )
      crtFailure("MANIFEST_INVALID");
    entries.set(entry.path, entry);
  }
  for (const name of names) {
    const [a, b] = CRT_TARGET_DIRECTORIES.map((directory) => entries.get(`${directory}/${name}`));
    if (!a || !b || a.size !== b.size || a.sha256 !== b.sha256) crtFailure("COHORT_MISMATCH");
  }
  return true;
}

export function requireCrtMetadata(bytes, manifestFiles) {
  if (!Buffer.isBuffer(bytes) || !sizeValid(bytes.length, 65536)) crtFailure("METADATA_INVALID");
  if (!requireCrtManifestFiles(manifestFiles)) crtFailure("CAPABILITY_INCOMPLETE");
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    crtFailure("METADATA_INVALID");
  }
  if (!bytes.equals(canonical(value))) crtFailure("METADATA_NOT_CANONICAL");
  if (
    !exactKeys(value, ["schema", "version", "platform", "source", "files", "license"]) ||
    value.schema !== "laundry.windows.crt-dependencies" ||
    value.version !== 1 ||
    value.platform !== "win32-x64" ||
    !exactKeys(value.source, ["version", "url", "sha256", "size", "format"]) ||
    typeof value.source.version !== "string" ||
    value.source.version.length > 64 ||
    !versionPattern.test(value.source.version) ||
    typeof value.source.url !== "string" ||
    !sourceUrl.test(value.source.url) ||
    !shaValid(value.source.sha256) ||
    !sizeValid(value.source.size, 64 * 1024 * 1024) ||
    value.source.format !== "microsoft-redist-exe-cab" ||
    !Array.isArray(value.files) ||
    value.files.length !== names.length ||
    !exactKeys(value.license, ["file_id", "size", "sha256", "path"]) ||
    typeof value.license.file_id !== "string" ||
    !/^[A-Za-z0-9_.-]{1,96}$/u.test(value.license.file_id) ||
    value.license.path !== CRT_LICENSE_NAME ||
    !sizeValid(value.license.size, 1024 * 1024) ||
    !shaValid(value.license.sha256)
  )
    crtFailure("METADATA_INVALID");
  const entries = new Map(manifestFiles.map((entry) => [entry.path, entry]));
  for (const [index, file] of value.files.entries()) {
    const destinations = CRT_TARGET_DIRECTORIES.map((directory) => `${directory}/${names[index]}`);
    if (
      !exactKeys(file, ["name", "file_id", "size", "sha256", "version", "destinations"]) ||
      file.name !== names[index] ||
      file.file_id !== `${file.name}_amd64` ||
      file.version !== value.source.version ||
      !sizeValid(file.size, 512 * 1024 * 1024) ||
      !shaValid(file.sha256) ||
      JSON.stringify(file.destinations) !== JSON.stringify(destinations)
    )
      crtFailure("METADATA_INVALID");
    for (const path of destinations) {
      const entry = entries.get(path);
      if (entry.size !== file.size || entry.sha256 !== file.sha256) crtFailure("METADATA_MISMATCH");
    }
  }
  for (const [path, size, sha256] of [
    [CRT_LICENSE_NAME, value.license.size, value.license.sha256],
    [CRT_METADATA_NAME, bytes.length, digest(bytes)],
  ]) {
    const entry = entries.get(path);
    if (!entry || entry.size !== size || entry.sha256 !== sha256) crtFailure("METADATA_MISMATCH");
  }
  return value;
}
