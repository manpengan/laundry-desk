import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exactKeys } from "./companion-contract.mjs";
import { hashFile, inventory, readBoundedFile, requireRealDirectory } from "./companion-files.mjs";
import { inspectCompanion } from "./inspect-companion.mjs";
import {
  bootstrapBinding,
  COMMAND_NAME,
  ENTRY_NAME,
  OPERATOR_HELPERS,
} from "./runtime-entry-contract.mjs";
import {
  deliveryFailure,
  HASH,
  parseJson,
  PROFILES,
  requireDeliveryInput,
  requireInstalledReport,
} from "./package-delivery-contract.mjs";

export async function trustedJson(path, expectedHash, limit = 65_536) {
  await requireRealDirectory(dirname(path));
  await requireCanonicalFile(path);
  const metadata = await hashFile(path);
  if (metadata.size < 1 || metadata.size > limit || metadata.sha256 !== expectedHash)
    deliveryFailure("RECEIPT_DIGEST_INVALID");
  return Object.freeze({
    metadata,
    value: parseJson(await readBoundedFile(path, metadata, limit)),
  });
}

async function requireCanonicalFile(path) {
  const actual = await realpath(path);
  if (process.platform === "win32" ? actual.toLowerCase() !== path.toLowerCase() : actual !== path)
    deliveryFailure("PATH_INVALID");
}

function requireOperatorEvidence(evidence, input) {
  if (
    !exactKeys(evidence, [
      "schema",
      "version",
      "assurance",
      "source_git_sha",
      "manifest_sha256",
      "entry_sha256",
      "bootstrap",
      "operator_files",
    ]) ||
    evidence.schema !== "laundry.windows.runtime-operator-entry" ||
    evidence.version !== 1 ||
    evidence.assurance !== "development_only" ||
    evidence.source_git_sha !== input.source_git_sha ||
    evidence.manifest_sha256 !== input.runtime_entry.manifest_sha256 ||
    typeof evidence.entry_sha256 !== "string" ||
    !HASH.test(evidence.entry_sha256) ||
    !Array.isArray(evidence.operator_files)
  )
    deliveryFailure("RUNTIME_BINDING_INVALID");
  const names = [...OPERATOR_HELPERS, COMMAND_NAME, ENTRY_NAME].sort();
  if (
    evidence.operator_files.some(
      (file) =>
        !exactKeys(file, ["path", "size", "sha256"]) ||
        !names.includes(file.path) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 1 ||
        file.size > 262_144 ||
        typeof file.sha256 !== "string" ||
        !HASH.test(file.sha256),
    ) ||
    JSON.stringify(evidence.operator_files.map(({ path }) => path).sort()) !== JSON.stringify(names)
  )
    deliveryFailure("OPERATOR_INVENTORY_INVALID");
}

async function inspectOperator(input) {
  const root = await requireRealDirectory(input.runtime_entry.directory);
  const receipt = await trustedJson(
    join(root, "release-evidence.json"),
    input.runtime_entry.evidence_sha256,
  );
  const evidence = receipt.value;
  requireOperatorEvidence(evidence, input);
  const manifest = await inspectCompanion(join(root, "payload"), evidence.manifest_sha256);
  const bootstrap = bootstrapBinding(manifest, evidence.manifest_sha256, input.source_git_sha);
  if (JSON.stringify(evidence.bootstrap) !== JSON.stringify(bootstrap))
    deliveryFailure("BOOTSTRAP_BINDING_INVALID");
  // A release directory is never a vehicle for database, credentials or backup state.
  if (
    manifest.files.some(({ path }) =>
      /^(?:secrets|credentials|backups|data|postgres-data|logs|user-data)(?:\/|$)/iu.test(path),
    )
  )
    deliveryFailure("RUNTIME_STATE_FORBIDDEN");
  const manifestMetadata = await hashFile(join(root, "payload/runtime-payload.json"));
  const expected = [
    ...evidence.operator_files,
    { path: "release-evidence.json", ...receipt.metadata },
    { path: "payload/runtime-payload.json", ...manifestMetadata },
    ...manifest.files.map(({ path, size, sha256 }) => ({ path: `payload/${path}`, size, sha256 })),
  ].sort((a, b) => (a.path < b.path ? -1 : 1));
  const actual = await inventory(root);
  if (
    JSON.stringify(actual.files) !== JSON.stringify(expected) ||
    actual.directories.some((dir) => !actual.files.some(({ path }) => path.startsWith(`${dir}/`)))
  )
    deliveryFailure("RUNTIME_INVENTORY_MISMATCH");
  const entryMetadata = evidence.operator_files.find(({ path }) => path === ENTRY_NAME);
  if (entryMetadata.sha256 !== evidence.entry_sha256) deliveryFailure("RUNTIME_BINDING_INVALID");
  const entry = (await readBoundedFile(join(root, ENTRY_NAME), entryMetadata, 262_144)).toString(
    "utf8",
  );
  if (
    !entry.includes(`$BoundSource = '${input.source_git_sha}'`) ||
    !entry.includes(`$BoundManifest = '${evidence.manifest_sha256}'`)
  )
    deliveryFailure("RUNTIME_BINDING_INVALID");
  return Object.freeze({ root, evidence, manifest, files: actual.files });
}

async function inspectCounter(item, profile, sourceSha, runtime) {
  const receipt = await trustedJson(item.installed_report, item.report_sha256);
  const report = requireInstalledReport(receipt.value, profile, sourceSha, runtime.evidence);
  await requireRealDirectory(dirname(item.installer));
  await requireCanonicalFile(item.installer);
  const installer = await hashFile(item.installer);
  if (
    installer.size < 1 ||
    installer.size > 256 * 1024 * 1024 ||
    installer.sha256 !== report.installer_sha256
  )
    deliveryFailure("INSTALLER_DIGEST_INVALID");
  return Object.freeze({ profile, report, installer, receipt: receipt.metadata });
}

export async function inspectDeliveryInputs(raw) {
  const input = requireDeliveryInput(raw);
  const runtime = await inspectOperator(input);
  const counters = await Promise.all(
    PROFILES.map((profile) =>
      inspectCounter(input.counters[profile], profile, input.source_git_sha, runtime),
    ),
  );
  return Object.freeze({ runtime, counters });
}
