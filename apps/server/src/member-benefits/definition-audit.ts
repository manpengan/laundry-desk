import type { BenefitDefinitionRecord } from "./types.js";

export function benefitDefinitionAuditSnapshot(
  definition: BenefitDefinitionRecord,
): Readonly<Record<string, unknown>> {
  switch (definition.kind) {
    case "tier":
      return Object.freeze({
        kind: definition.kind,
        code: definition.code,
        name: definition.name,
        level: definition.level,
        discount_bps: definition.discount_bps,
        status: definition.status,
        version: definition.version,
        note: definition.note,
      });
    case "points_policy":
      return Object.freeze({
        kind: definition.kind,
        unit_cents: definition.unit_cents,
        points_per_unit: definition.points_per_unit,
        valid_days: definition.valid_days,
        status: definition.status,
        version: definition.version,
        note: definition.note,
      });
    case "punch_type":
      return Object.freeze({
        kind: definition.kind,
        code: definition.code,
        name: definition.name,
        total_uses: definition.total_uses,
        valid_days: definition.valid_days,
        status: definition.status,
        version: definition.version,
        note: definition.note,
      });
    case "coupon_type":
      return Object.freeze({
        kind: definition.kind,
        code: definition.code,
        name: definition.name,
        discount_cents: definition.discount_cents,
        min_order_cents: definition.min_order_cents,
        valid_days: definition.valid_days,
        status: definition.status,
        version: definition.version,
        note: definition.note,
      });
  }
}
