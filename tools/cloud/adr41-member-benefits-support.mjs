import {
  asRecord,
  requireInteger,
  requireString,
  requireThat,
  requireUuid,
} from "./adr36-web-core.mjs";

export const MEMBER_BENEFIT_TEST_POLICY = Object.freeze({
  kind: "points_policy",
  unit_cents: 100,
  points_per_unit: 1,
  valid_days: 30,
  status: "active",
});

export function readMemberBenefitCatalog(value) {
  const catalog = asRecord(value, "MEMBER_BENEFIT_CATALOG_INVALID");
  requireThat(
    Array.isArray(catalog.tiers) &&
      Array.isArray(catalog.punch_types) &&
      Array.isArray(catalog.coupon_types) &&
      (catalog.points_policy === null || typeof catalog.points_policy === "object"),
    "MEMBER_BENEFIT_CATALOG_INVALID",
  );
  return catalog;
}

export function memberBenefitMutation(value) {
  const result = asRecord(value, "MEMBER_BENEFIT_MUTATION_INVALID");
  return asRecord(result.benefits, "MEMBER_BENEFIT_MUTATION_INVALID");
}

export function findMemberBenefitByCode(rows, code, errorCode) {
  const matches = rows.filter((value) => asRecord(value, errorCode).code === code);
  requireThat(matches.length === 1, errorCode);
  return asRecord(matches[0], errorCode);
}

function optionalNote(row) {
  return typeof row.note === "string" ? { note: row.note } : {};
}

export function retiredDefinition(kind, row) {
  const common = {
    kind,
    definition_id: requireUuid(row.definition_id, "MEMBER_BENEFIT_CLEANUP_INVALID"),
    expected_version: requireInteger(row.version, "MEMBER_BENEFIT_CLEANUP_INVALID"),
    code: requireString(row.code, "MEMBER_BENEFIT_CLEANUP_INVALID"),
    name: requireString(row.name, "MEMBER_BENEFIT_CLEANUP_INVALID"),
    status: "retired",
    ...optionalNote(row),
  };
  if (kind === "tier") {
    return { ...common, level: row.level, discount_bps: row.discount_bps };
  }
  if (kind === "punch_type") {
    return { ...common, total_uses: row.total_uses, valid_days: row.valid_days };
  }
  return {
    ...common,
    discount_cents: row.discount_cents,
    min_order_cents: row.min_order_cents,
    valid_days: row.valid_days,
  };
}

export function restoredPolicy(current, source) {
  return {
    kind: "points_policy",
    expected_version: requireInteger(current.version, "MEMBER_BENEFIT_CLEANUP_INVALID"),
    unit_cents: source.unit_cents,
    points_per_unit: source.points_per_unit,
    valid_days: source.valid_days,
    status: source.status,
    ...optionalNote(source),
  };
}

export function memberBenefitJourneyContext(options) {
  const input = asRecord(options, "MEMBER_BENEFIT_OPTIONS_INVALID");
  const api = asRecord(input.api, "MEMBER_BENEFIT_API_INVALID");
  requireThat(
    ["command", "confirm", "expectCommandFailure", "query"].every(
      (method) => typeof api[method] === "function",
    ),
    "MEMBER_BENEFIT_API_INVALID",
  );
  requireThat(typeof input.update === "function", "MEMBER_BENEFIT_UPDATE_INVALID");
  const artifacts = asRecord(input.artifacts, "MEMBER_BENEFIT_ARTIFACTS_INVALID");
  const run = asRecord(input.run, "MEMBER_BENEFIT_RUN_INVALID");
  return Object.freeze({
    api,
    session: asRecord(input.adminSession, "MEMBER_BENEFIT_SESSION_INVALID"),
    artifacts,
    run,
    update: input.update,
    customerId: requireUuid(artifacts.customerId, "MEMBER_BENEFIT_ARTIFACTS_INVALID"),
    cashOrderId: requireUuid(artifacts.cashOrderId, "MEMBER_BENEFIT_ARTIFACTS_INVALID"),
    note: requireString(run.note, "MEMBER_BENEFIT_RUN_INVALID"),
    codeBase: requireString(run.catalogCode, "MEMBER_BENEFIT_RUN_INVALID"),
  });
}
