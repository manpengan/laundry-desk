import { randomUUID } from "node:crypto";

import type { SqlClient, TenantContext } from "../db/types.js";
import { benefitInteger, rejectPgBenefit } from "./pg-support.js";
import type {
  BenefitDefinitionInput,
  BenefitDefinitionRecord,
  DefinitionMutationResult,
  DefinitionUpsertStoreInput,
  MemberBenefitCatalogView,
  MemberBenefitOutcome,
} from "./types.js";

type CommonDefinitionRow = Readonly<{
  id: string;
  code: string;
  name: string;
  status: string;
  version: number | string;
  note: string | null;
}>;
type TierRow = CommonDefinitionRow &
  Readonly<{ level: number | string; discount_bps: number | string }>;
type PunchRow = CommonDefinitionRow &
  Readonly<{ total_uses: number | string; valid_days: number | string }>;
type CouponRow = CommonDefinitionRow &
  Readonly<{
    discount_cents: number | string;
    min_order_cents: number | string;
    valid_days: number | string;
  }>;
type PolicyRow = Readonly<{
  id: string;
  unit_cents: number | string;
  points_per_unit: number | string;
  valid_days: number | string;
  status: string;
  version: number | string;
  note: string | null;
}>;

function statusOf(value: string): "active" | "retired" {
  if (value !== "active" && value !== "retired")
    throw new Error(`Unknown definition status: ${value}`);
  return value;
}

const tierRecord = (row: TierRow): Extract<BenefitDefinitionRecord, { kind: "tier" }> =>
  Object.freeze({
    kind: "tier",
    definition_id: row.id,
    code: row.code,
    name: row.name,
    level: benefitInteger(row.level, "tier level"),
    discount_bps: benefitInteger(row.discount_bps, "tier discount"),
    status: statusOf(row.status),
    version: benefitInteger(row.version, "tier version"),
    note: row.note,
  });

const punchRecord = (row: PunchRow): Extract<BenefitDefinitionRecord, { kind: "punch_type" }> =>
  Object.freeze({
    kind: "punch_type",
    definition_id: row.id,
    code: row.code,
    name: row.name,
    total_uses: benefitInteger(row.total_uses, "punch uses"),
    valid_days: benefitInteger(row.valid_days, "punch days"),
    status: statusOf(row.status),
    version: benefitInteger(row.version, "punch version"),
    note: row.note,
  });

const couponRecord = (row: CouponRow): Extract<BenefitDefinitionRecord, { kind: "coupon_type" }> =>
  Object.freeze({
    kind: "coupon_type",
    definition_id: row.id,
    code: row.code,
    name: row.name,
    discount_cents: benefitInteger(row.discount_cents, "coupon discount"),
    min_order_cents: benefitInteger(row.min_order_cents, "coupon minimum"),
    valid_days: benefitInteger(row.valid_days, "coupon days"),
    status: statusOf(row.status),
    version: benefitInteger(row.version, "coupon version"),
    note: row.note,
  });

const policyRecord = (
  row: PolicyRow,
): Extract<BenefitDefinitionRecord, { kind: "points_policy" }> =>
  Object.freeze({
    kind: "points_policy",
    policy_id: row.id,
    unit_cents: benefitInteger(row.unit_cents, "points unit"),
    points_per_unit: benefitInteger(row.points_per_unit, "points rate"),
    valid_days: benefitInteger(row.valid_days, "points days"),
    status: statusOf(row.status),
    version: benefitInteger(row.version, "points version"),
    note: row.note,
  });

const tierView = (
  tier: Extract<BenefitDefinitionRecord, { kind: "tier" }>,
): MemberBenefitCatalogView["tiers"][number] =>
  Object.freeze({
    definition_id: tier.definition_id,
    code: tier.code,
    name: tier.name,
    level: tier.level,
    discount_bps: tier.discount_bps,
    status: tier.status,
    version: tier.version,
    note: tier.note,
  });

const pointsPolicyView = (
  policy: Extract<BenefitDefinitionRecord, { kind: "points_policy" }>,
): NonNullable<MemberBenefitCatalogView["points_policy"]> =>
  Object.freeze({
    policy_id: policy.policy_id,
    unit_cents: policy.unit_cents,
    points_per_unit: policy.points_per_unit,
    valid_days: policy.valid_days,
    status: policy.status,
    version: policy.version,
    note: policy.note,
  });

const punchTypeView = (
  definition: Extract<BenefitDefinitionRecord, { kind: "punch_type" }>,
): MemberBenefitCatalogView["punch_types"][number] =>
  Object.freeze({
    definition_id: definition.definition_id,
    code: definition.code,
    name: definition.name,
    total_uses: definition.total_uses,
    valid_days: definition.valid_days,
    status: definition.status,
    version: definition.version,
    note: definition.note,
  });

const couponTypeView = (
  definition: Extract<BenefitDefinitionRecord, { kind: "coupon_type" }>,
): MemberBenefitCatalogView["coupon_types"][number] =>
  Object.freeze({
    definition_id: definition.definition_id,
    code: definition.code,
    name: definition.name,
    discount_cents: definition.discount_cents,
    min_order_cents: definition.min_order_cents,
    valid_days: definition.valid_days,
    status: definition.status,
    version: definition.version,
    note: definition.note,
  });

export async function readPgBenefitCatalog(
  client: SqlClient,
  tenant: TenantContext,
  includeRetired: boolean,
): Promise<MemberBenefitCatalogView> {
  const filter = includeRetired ? "" : "AND status = 'active'";
  const tiers = await client.query<TierRow>(
    `SELECT id::text, code, name, level, discount_bps, status, version, note
       FROM member_tiers WHERE org_id = $1::uuid ${filter}
      ORDER BY code ASC LIMIT 50`,
    [tenant.orgId],
  );
  const policy = await client.query<PolicyRow>(
    `SELECT id::text, unit_cents, points_per_unit, valid_days, status, version, note
       FROM member_points_policies WHERE org_id = $1::uuid ${filter}
      LIMIT 1`,
    [tenant.orgId],
  );
  const punches = await client.query<PunchRow>(
    `SELECT id::text, code, name, total_uses, valid_days, status, version, note
       FROM member_punch_types WHERE org_id = $1::uuid ${filter}
      ORDER BY code ASC LIMIT 50`,
    [tenant.orgId],
  );
  const coupons = await client.query<CouponRow>(
    `SELECT id::text, code, name, discount_cents, min_order_cents, valid_days,
            status, version, note
       FROM coupons WHERE org_id = $1::uuid ${filter}
      ORDER BY code ASC LIMIT 50`,
    [tenant.orgId],
  );
  return Object.freeze({
    tiers: Object.freeze(tiers.rows.map(({ id, ...row }) => tierView(tierRecord({ id, ...row })))),
    points_policy:
      policy.rows[0] === undefined ? null : pointsPolicyView(policyRecord(policy.rows[0])),
    punch_types: Object.freeze(
      punches.rows.map(({ id, ...row }) => punchTypeView(punchRecord({ id, ...row }))),
    ),
    coupon_types: Object.freeze(
      coupons.rows.map(({ id, ...row }) => couponTypeView(couponRecord({ id, ...row }))),
    ),
  });
}

async function upsertSingletonPolicy(
  client: SqlClient,
  tenant: TenantContext,
  input: DefinitionUpsertStoreInput,
  definition: Extract<BenefitDefinitionInput, { kind: "points_policy" }>,
  newId: () => string,
): Promise<MemberBenefitOutcome<BenefitDefinitionRecord>> {
  const creating = definition.expected_version === 0;
  const query = creating
    ? `INSERT INTO member_points_policies (
         id, org_id, unit_cents, points_per_unit, valid_days, status, version,
         updated_at, updated_by_staff_id, note
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 1, to_timestamp($7), $8::uuid, $9)
       ON CONFLICT (org_id) DO NOTHING
       RETURNING id::text, unit_cents, points_per_unit, valid_days, status, version, note`
    : `UPDATE member_points_policies
          SET unit_cents = $1, points_per_unit = $2, valid_days = $3, status = $4,
              version = version + 1, updated_at = to_timestamp($5),
              updated_by_staff_id = $6::uuid, note = $7
        WHERE org_id = $8::uuid AND version = $9
        RETURNING id::text, unit_cents, points_per_unit, valid_days, status, version, note`;
  const common = [
    definition.unit_cents,
    definition.points_per_unit,
    definition.valid_days,
    definition.status,
    input.at,
    input.staff_id,
    definition.note ?? null,
  ] as const;
  const params = creating
    ? Object.freeze([newId(), tenant.orgId, ...common])
    : Object.freeze([...common, tenant.orgId, definition.expected_version]);
  const result = await client.query<PolicyRow>(query, params);
  return result.rows[0] === undefined
    ? rejectPgBenefit("definition_version_conflict")
    : Object.freeze({ ok: true as const, value: policyRecord(result.rows[0]) });
}

type DefinitionSql = Readonly<{
  table: "member_tiers" | "member_punch_types" | "coupons";
  columns: string;
  values: readonly unknown[];
  returning: string;
  map: (row: CommonDefinitionRow & Record<string, number | string>) => BenefitDefinitionRecord;
}>;

function definitionSql(
  definition: Exclude<BenefitDefinitionInput, { kind: "points_policy" }>,
): DefinitionSql {
  if (definition.kind === "tier") {
    return Object.freeze({
      table: "member_tiers",
      columns: "level, discount_bps",
      values: [definition.level, definition.discount_bps],
      returning: "level, discount_bps",
      map: (row) => tierRecord(row as TierRow),
    });
  }
  if (definition.kind === "punch_type") {
    return Object.freeze({
      table: "member_punch_types",
      columns: "total_uses, valid_days",
      values: [definition.total_uses, definition.valid_days],
      returning: "total_uses, valid_days",
      map: (row) => punchRecord(row as PunchRow),
    });
  }
  return Object.freeze({
    table: "coupons",
    columns: "discount_cents, min_order_cents, valid_days",
    values: [definition.discount_cents, definition.min_order_cents, definition.valid_days],
    returning: "discount_cents, min_order_cents, valid_days",
    map: (row) => couponRecord(row as CouponRow),
  });
}

export async function upsertPgBenefitDefinition(
  client: SqlClient,
  tenant: TenantContext,
  input: DefinitionUpsertStoreInput,
  newId: () => string = randomUUID,
): Promise<MemberBenefitOutcome<DefinitionMutationResult>> {
  const definition = input.definition;
  let result: MemberBenefitOutcome<BenefitDefinitionRecord>;
  if (definition.kind === "points_policy") {
    result = await upsertSingletonPolicy(client, tenant, input, definition, newId);
  } else {
    const spec = definitionSql(definition);
    const id = definition.definition_id ?? newId();
    const common = [
      id,
      tenant.orgId,
      definition.code,
      definition.name,
      ...spec.values,
      definition.status,
      input.at,
      input.staff_id,
      definition.note ?? null,
    ];
    const valueStart = 5;
    const valueRefs = spec.values.map((_, index) => `$${valueStart + index}`).join(", ");
    const statusIndex = valueStart + spec.values.length;
    const atIndex = statusIndex + 1;
    const staffIndex = atIndex + 1;
    const noteIndex = staffIndex + 1;
    const versionIndex = noteIndex + 1;
    const query =
      definition.expected_version === 0
        ? `INSERT INTO ${spec.table} (id, org_id, code, name, ${spec.columns}, status, version,
             updated_at, updated_by_staff_id, note)
           VALUES ($1::uuid, $2::uuid, $3, $4, ${valueRefs}, $${statusIndex}, 1,
             to_timestamp($${atIndex}), $${staffIndex}::uuid, $${noteIndex})
           ON CONFLICT (org_id, code) DO NOTHING
           RETURNING id::text, code, name, ${spec.returning}, status, version, note`
        : `UPDATE ${spec.table}
            SET code = $3, name = $4, ${spec.values.map((_, index) => `${spec.columns.split(", ")[index]} = $${valueStart + index}`).join(", ")},
                status = $${statusIndex}, version = version + 1,
                updated_at = to_timestamp($${atIndex}), updated_by_staff_id = $${staffIndex}::uuid,
                note = $${noteIndex}
          WHERE org_id = $2::uuid AND id = $1::uuid AND version = $${versionIndex}
            AND NOT EXISTS (
              SELECT 1 FROM ${spec.table} duplicate
               WHERE duplicate.org_id = $2::uuid AND duplicate.code = $3 AND duplicate.id <> $1::uuid
            )
          RETURNING id::text, code, name, ${spec.returning}, status, version, note`;
    const params =
      definition.expected_version === 0
        ? common
        : Object.freeze([...common, definition.expected_version]);
    const rows = await client.query<CommonDefinitionRow & Record<string, number | string>>(
      query,
      params,
    );
    if (rows.rows[0] === undefined) {
      const duplicate = await client.query(
        `SELECT 1 FROM ${spec.table} WHERE org_id = $1::uuid AND code = $2 AND id <> $3::uuid`,
        [tenant.orgId, definition.code, id],
      );
      result = rejectPgBenefit(
        duplicate.rows.length > 0 ? "definition_code_conflict" : "definition_version_conflict",
      );
    } else {
      result = Object.freeze({ ok: true as const, value: spec.map(rows.rows[0]) });
    }
  }
  if (!result.ok) return result;
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      definition: result.value,
      catalog: await readPgBenefitCatalog(client, tenant, true),
    }),
  });
}
