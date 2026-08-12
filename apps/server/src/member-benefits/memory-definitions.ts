import { benefitsFromState, catalogFromState } from "./memory-view.js";
import { mapWith, type MemoryBenefitsContext } from "./memory-state.js";
import { rejectBenefit, requireActiveAccount } from "./memory-support.js";
import type {
  BenefitDefinitionInput,
  BenefitDefinitionRecord,
  DefinitionMutationResult,
  DefinitionUpsertStoreInput,
  MemberBenefitOutcome,
  MembershipSetStoreInput,
  BenefitMutationResult,
} from "./types.js";

const noteOf = (definition: BenefitDefinitionInput): string | null => definition.note ?? null;

function definitionRecord(
  definition: BenefitDefinitionInput,
  id: string,
  version: number,
): BenefitDefinitionRecord {
  switch (definition.kind) {
    case "tier":
      return Object.freeze({
        kind: definition.kind,
        definition_id: id,
        code: definition.code,
        name: definition.name,
        level: definition.level,
        discount_bps: definition.discount_bps,
        status: definition.status,
        version,
        note: noteOf(definition),
      });
    case "points_policy":
      return Object.freeze({
        kind: definition.kind,
        policy_id: id,
        unit_cents: definition.unit_cents,
        points_per_unit: definition.points_per_unit,
        valid_days: definition.valid_days,
        status: definition.status,
        version,
        note: noteOf(definition),
      });
    case "punch_type":
      return Object.freeze({
        kind: definition.kind,
        definition_id: id,
        code: definition.code,
        name: definition.name,
        total_uses: definition.total_uses,
        valid_days: definition.valid_days,
        status: definition.status,
        version,
        note: noteOf(definition),
      });
    case "coupon_type":
      return Object.freeze({
        kind: definition.kind,
        definition_id: id,
        code: definition.code,
        name: definition.name,
        discount_cents: definition.discount_cents,
        min_order_cents: definition.min_order_cents,
        valid_days: definition.valid_days,
        status: definition.status,
        version,
        note: noteOf(definition),
      });
  }
}

const codeConflicts = <TValue extends Readonly<{ definition_id: string; code: string }>>(
  values: Iterable<TValue>,
  id: string,
  code: string,
): boolean => [...values].some((value) => value.definition_id !== id && value.code === code);

export async function upsertMemoryDefinition(
  context: MemoryBenefitsContext,
  input: DefinitionUpsertStoreInput,
): Promise<MemberBenefitOutcome<DefinitionMutationResult>> {
  const state = context.read();
  const definition = input.definition;

  if (definition.kind === "points_policy") {
    const current = state.pointsPolicy;
    if (
      (current === null && definition.expected_version !== 0) ||
      (current !== null && definition.expected_version !== current.version)
    ) {
      return rejectBenefit("definition_version_conflict");
    }
    const record = definitionRecord(
      definition,
      current?.policy_id ?? context.newId(),
      (current?.version ?? 0) + 1,
    ) as Extract<BenefitDefinitionRecord, { kind: "points_policy" }>;
    const next = Object.freeze({ ...state, pointsPolicy: record });
    context.write(next);
    return Object.freeze({
      ok: true as const,
      value: Object.freeze({ definition: record, catalog: catalogFromState(next, true) }),
    });
  }

  const values: readonly Exclude<BenefitDefinitionRecord, { kind: "points_policy" }>[] =
    definition.kind === "tier"
      ? [...state.tiers.values()]
      : definition.kind === "punch_type"
        ? [...state.punchTypes.values()]
        : [...state.couponTypes.values()];
  const requestedId = definition.definition_id;
  const current =
    requestedId === undefined
      ? undefined
      : values.find((candidate) => candidate.definition_id === requestedId);
  if (
    (requestedId === undefined && definition.expected_version !== 0) ||
    (requestedId !== undefined &&
      (current === undefined || current.version !== definition.expected_version))
  ) {
    return rejectBenefit("definition_version_conflict");
  }
  const id = requestedId ?? context.newId();
  if (codeConflicts(values, id, definition.code)) {
    return rejectBenefit("definition_code_conflict");
  }
  const record = definitionRecord(definition, id, (current?.version ?? 0) + 1);
  if (record.kind === "points_policy") {
    throw new Error("Non-policy definition produced a points policy record");
  }
  const next =
    record.kind === "tier"
      ? Object.freeze({ ...state, tiers: mapWith(state.tiers, id, record) })
      : record.kind === "punch_type"
        ? Object.freeze({ ...state, punchTypes: mapWith(state.punchTypes, id, record) })
        : Object.freeze({ ...state, couponTypes: mapWith(state.couponTypes, id, record) });
  context.write(next);
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({ definition: record, catalog: catalogFromState(next, true) }),
  });
}

export async function setMemoryMembership(
  context: MemoryBenefitsContext,
  input: MembershipSetStoreInput,
): Promise<MemberBenefitOutcome<BenefitMutationResult>> {
  const account = await requireActiveAccount(context, input.account_id);
  if (!account.ok) return account;
  const state = context.read();
  const current = state.memberships.get(input.account_id);
  if ((current?.version ?? 0) !== input.expected_version) {
    return rejectBenefit("membership_version_conflict");
  }

  const tier = input.tier_id === null ? null : state.tiers.get(input.tier_id);
  if (input.tier_id !== null && tier === undefined) return rejectBenefit("definition_not_found");
  if (tier?.status === "retired") return rejectBenefit("definition_retired");
  if (input.valid_until !== null && input.valid_until < input.business_date) {
    return rejectBenefit("past_expiry");
  }
  const membership = Object.freeze({
    account_id: input.account_id,
    version: (current?.version ?? 0) + 1,
    tier:
      tier === undefined || tier === null
        ? null
        : Object.freeze({
            definition_id: tier.definition_id,
            code: tier.code,
            name: tier.name,
            level: tier.level,
            definition_version: tier.version,
            discount_bps: tier.discount_bps,
          }),
    valid_until: input.valid_until,
  });
  const next = Object.freeze({
    ...state,
    memberships: mapWith(state.memberships, input.account_id, membership),
  });
  context.write(next);
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      benefits: benefitsFromState(next, account.value, input.business_date, true),
      entity_id: input.account_id,
      changed: true,
    }),
  });
}
