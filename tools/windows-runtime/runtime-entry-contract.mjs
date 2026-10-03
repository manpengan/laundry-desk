import {
  canonicalManifest,
  digest,
  requireManifest,
  supportsBackup,
} from "./companion-contract.mjs";

export const ENTRY_NAME = "runtime-entry.ps1";
export const COMMAND_NAME = "Laundry Runtime V2.cmd";
export const OPERATOR_HELPERS = Object.freeze([
  "runtime-entry-ui.ps1",
  "runtime-entry-data-ui.ps1",
  "runtime-entry-schedule-ui.ps1",
  "runtime-entry-assistance-ui.ps1",
  "runtime-entry-install.ps1",
  "runtime-entry-shortcut.ps1",
]);
export const ENTRY_ACTIONS = Object.freeze([
  "install",
  "status",
  "diagnostics",
  "start",
  "stop",
  "repair",
  "upgrade",
  "rollback",
  "backup",
  "backup-list",
  "backup-verify",
  "backup-drill",
  "backup-health",
  "backup-schedule",
  "assistance-config",
  "scheduled-backup",
  "restore",
  "maintenance-recover",
  "portable-export",
  "portable-inspect",
  "portable-import",
  "v1-import",
  "export-store",
]);
const SHA = /^[a-f0-9]{64}$/u;

export function entryFailure(code) {
  throw new Error(`WINDOWS_RUNTIME_ENTRY_${code}`);
}

export function bootstrapBinding(manifest, manifestDigest, sourceSha) {
  requireManifest(manifest);
  if (
    !SHA.test(manifestDigest) ||
    digest(canonicalManifest(manifest)) !== manifestDigest ||
    manifest.source_git_sha !== sourceSha ||
    !supportsBackup(manifest)
  )
    entryFailure("BINDING_INVALID");
  const files = manifest.files.filter(
    ({ path }) => path === "node/node.exe" || path.startsWith("scripts/"),
  );
  if (files.some(({ path }) => !/^(?:node\/node\.exe|scripts\/[a-z-]+\.(?:mjs|ps1))$/u.test(path)))
    entryFailure("BOOTSTRAP_INVALID");
  for (const path of [
    "node/node.exe",
    "scripts/lifecycle-launch.ps1",
    "scripts/lifecycle-native.ps1",
    "scripts/lifecycle-cli.mjs",
  ])
    if (!files.some((entry) => entry.path === path)) entryFailure("BOOTSTRAP_INVALID");
  return Object.freeze(files.map((entry) => Object.freeze({ ...entry })));
}

export function powershellBinding(files) {
  return `@(\n${files
    .map(({ path, size, sha256 }) => {
      if (
        !/^[a-zA-Z0-9 /.-]+$/u.test(path) ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        !SHA.test(sha256)
      )
        entryFailure("BINDING_INVALID");
      return `  @{ path = '${path}'; size = ${size}; sha256 = '${sha256}' }`;
    })
    .join("\n")}\n)`;
}

export function renderEntry(template, replacements) {
  let result = template;
  for (const [name, replacement] of Object.entries(replacements)) {
    const token = `@@${name}@@`;
    if (result.split(token).length !== 2) entryFailure("TEMPLATE_INVALID");
    result = result.replace(token, () => replacement);
  }
  if (/@@[A-Z_]+@@/u.test(result)) entryFailure("TEMPLATE_INVALID");
  return result;
}

export function requireEntryArguments(action, backupId, confirmation) {
  if (!ENTRY_ACTIONS.includes(action)) entryFailure("ARGS_INVALID");
  const id = typeof backupId === "string" && /^b_[a-f0-9]{32}$/u.test(backupId);
  const confirm = typeof confirmation === "string" && SHA.test(confirmation);
  if (
    action === "restore"
      ? !id || !confirm
      : action === "backup-verify" || action === "backup-drill"
        ? !id || confirmation !== undefined
        : backupId !== undefined || confirmation !== undefined
  )
    entryFailure("ARGS_INVALID");
  return Object.freeze({
    action,
    ...(id ? { backupId } : {}),
    ...(confirm ? { confirmation } : {}),
  });
}
