import { ISO_UTC, SHA256, exactObject } from "./schema.mjs";

const SAFE_VERSION_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,127}$/u;

function exactPassedChecks(value) {
  const keys = [
    "counter_codesign",
    "counter_gatekeeper",
    "counter_stapler",
    "runtime_codesign",
    "runtime_gatekeeper",
    "runtime_stapler",
    "verifier_codesign",
    "verifier_gatekeeper",
    "verifier_stapler",
  ];
  exactObject(value, keys, "RC_CLEAN_MAC_REPORT_INVALID");
  if (keys.some((key) => value[key] !== true)) throw new Error("RC_CLEAN_MAC_REPORT_INVALID");
}

export function validateTransferReport(value, context) {
  exactObject(
    value,
    [
      "assurance",
      "cleanup",
      "completed_at",
      "database_sha256",
      "git_sha",
      "kind",
      "photos_sha256",
      "postgres_image_digest",
      "product_version",
      "roots",
      "schema_version",
      "server_image_digest",
      "status",
    ],
    "RC_TRANSFER_REPORT_INVALID",
  );
  if (
    value.schema_version !== 1 ||
    value.kind !== "runtime_real_container_transfer" ||
    value.status !== "passed" ||
    value.cleanup !== "clean" ||
    value.roots !== 2 ||
    value.git_sha !== context.gitSha ||
    value.product_version !== context.version ||
    value.server_image_digest !== context.serverDigest ||
    value.postgres_image_digest !== context.postgresDigest ||
    !ISO_UTC.test(value.completed_at) ||
    !SHA256.test(value.database_sha256) ||
    !SHA256.test(value.photos_sha256) ||
    value.assurance !== (context.formal ? "real_container" : "software_only")
  ) {
    throw new Error("RC_TRANSFER_REPORT_INVALID");
  }
}

export function validateCleanMacReport(value, context) {
  exactObject(
    value,
    [
      "assurance",
      "checks",
      "counter_app_tree_sha256",
      "git_sha",
      "kind",
      "machine_fingerprint_sha256",
      "no_repository",
      "node_or_pnpm_invoked",
      "os_version",
      "product_version",
      "runtime_app_tree_sha256",
      "schema_version",
      "status",
      "team_identifier",
      "verified_at",
      "verifier_app_tree_sha256",
    ],
    "RC_CLEAN_MAC_REPORT_INVALID",
  );
  exactPassedChecks(value.checks);
  if (
    value.schema_version !== 1 ||
    value.kind !== "clean_second_mac" ||
    value.status !== "passed" ||
    value.git_sha !== context.gitSha ||
    value.product_version !== context.version ||
    value.counter_app_tree_sha256 !== context.counterTree ||
    value.runtime_app_tree_sha256 !== context.runtimeTree ||
    value.verifier_app_tree_sha256 !== context.verifierTree ||
    !SHA256.test(value.machine_fingerprint_sha256) ||
    !SAFE_VERSION_TEXT.test(value.os_version) ||
    value.no_repository !== true ||
    value.node_or_pnpm_invoked !== false ||
    !ISO_UTC.test(value.verified_at) ||
    value.assurance !== (context.formal ? "clean_physical_mac" : "software_only") ||
    (context.formal
      ? value.team_identifier !== context.team
      : value.team_identifier !== "software_only")
  ) {
    throw new Error("RC_CLEAN_MAC_REPORT_INVALID");
  }
}

export function validateXp58Report(value, context) {
  exactObject(
    value,
    [
      "accepted_at",
      "app_version",
      "cups_job_fingerprint",
      "job_fingerprint",
      "operator_confirmation",
      "platform",
      "printer_family",
      "queue_fingerprint",
      "receipt_seq",
      "schema_version",
      "snapshot_sha256",
    ],
    "RC_XP58_REPORT_INVALID",
  );
  const confirmations = [
    "amounts_correct",
    "barcode_scanned",
    "chinese_clear",
    "cut_or_tear_ok",
    "disconnect_no_duplicate",
    "explicit_reprint_one_copy",
    "feed_ok",
  ];
  exactObject(value.operator_confirmation, confirmations, "RC_XP58_REPORT_INVALID");
  if (
    value.schema_version !== 2 ||
    value.platform !== "darwin" ||
    value.printer_family !== "xp58" ||
    value.app_version !== context.version ||
    !ISO_UTC.test(value.accepted_at) ||
    !SHA256.test(value.job_fingerprint) ||
    !SHA256.test(value.snapshot_sha256) ||
    !SHA256.test(value.queue_fingerprint) ||
    !SHA256.test(value.cups_job_fingerprint) ||
    !Number.isSafeInteger(value.receipt_seq) ||
    value.receipt_seq < 1 ||
    confirmations.some((key) => value.operator_confirmation[key] !== true)
  ) {
    throw new Error("RC_XP58_REPORT_INVALID");
  }
}

export function assertFormalStrings(value) {
  const forbidden =
    /(?:^|[^a-z])(?:ad[ -]?hoc|example|placeholder|software[ _-]?only|testing)(?:$|[^a-z])/iu;
  const visit = (candidate) => {
    if (typeof candidate === "string" && forbidden.test(candidate)) {
      throw new Error("RC_FORMAL_PLACEHOLDER_EVIDENCE_FORBIDDEN");
    }
    if (Array.isArray(candidate)) candidate.forEach(visit);
    else if (typeof candidate === "object" && candidate !== null)
      Object.values(candidate).forEach(visit);
  };
  visit(value);
}
