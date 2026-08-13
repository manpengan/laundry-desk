import {
  AutomationPolicySchema,
  AutomationRunSchema,
  type AutomationPolicy,
  type AutomationPolicyDraft,
} from "@laundry/contracts";

import type {
  AutomationAttempt,
  AutomationAttemptAuthorization,
  AutomationAttemptSettlement,
  AutomationRecordOnlyAttempt,
  AutomationStore,
  AutomationStoreContext,
  AutomationTransition,
  StoredAutomationPolicy,
} from "./types.js";

type PolicyRow = Readonly<{
  policy_id: string;
  org_id: string;
  store_id: string;
  name: string;
  tool: string;
  tool_version: string;
  object_filter: unknown;
  schedule: unknown;
  limits: unknown;
  status: string;
  row_version: number;
  valid_from: Date | string;
  valid_until: Date | string | null;
  approved_by_staff_id: string | null;
  approved_at: Date | string | null;
  next_run_at: Date | string | null;
  last_run_at: Date | string | null;
  last_outcome: string | null;
  consecutive_failures: number;
  created_by_staff_id: string;
  updated_by_staff_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}>;

type RunRow = Readonly<{
  run_id: string;
  policy_id: string;
  tool: string;
  decision: string;
  outcome: string;
  args_sha256: string;
  object_count: number;
  amount_cents: number;
  error_code: string | null;
  started_at: Date | string;
  completed_at: Date | string;
}>;

const POLICY_COLUMNS = `
  policy_row.id::text AS policy_id, policy_row.org_id::text, policy_row.store_id::text,
  policy_row.name, policy_row.tool, policy_row.tool_version,
  policy_row.object_filter_json AS object_filter, policy_row.schedule_json AS schedule,
  policy_row.limits_json AS limits, policy_row.status, policy_row.row_version,
  policy_row.valid_from, policy_row.valid_until, policy_row.approved_by_staff_id::text,
  policy_row.approved_at, policy_row.next_run_at, policy_row.last_run_at,
  policy_row.last_outcome, policy_row.consecutive_failures,
  policy_row.created_by_staff_id::text, policy_row.updated_by_staff_id::text,
  policy_row.created_at, policy_row.updated_at`;

const iso = (value: Date | string): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();
const nullableIso = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);

function parsePolicy(row: PolicyRow): StoredAutomationPolicy {
  const policy = AutomationPolicySchema.parse({
    ...row,
    valid_from: iso(row.valid_from),
    valid_until: nullableIso(row.valid_until),
    approved_at: nullableIso(row.approved_at),
    next_run_at: nullableIso(row.next_run_at),
    last_run_at: nullableIso(row.last_run_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  });
  return Object.freeze({
    ...policy,
    org_id: row.org_id,
    created_by_staff_id: row.created_by_staff_id,
    updated_by_staff_id: row.updated_by_staff_id,
  });
}

function parseRun(row: RunRow) {
  return AutomationRunSchema.parse({
    ...row,
    started_at: iso(row.started_at),
    completed_at: iso(row.completed_at),
  });
}

const contextValues = (context: AutomationStoreContext) =>
  [context.tenant.orgId, context.tenant.storeId] as const;

async function writePolicy(
  context: AutomationStoreContext,
  operation: string,
  id: string,
  expectedVersion: number | null,
  draft: AutomationPolicyDraft | null,
): Promise<boolean> {
  const result = await context.client.query<{ changed: boolean }>(
    `SELECT public.automation_policy_write(
       $1::text, $2::uuid, $3::integer, $4::text, $5::text, $6::text,
       $7::jsonb, $8::jsonb, $9::jsonb, $10::timestamptz, $11::timestamptz
     ) AS changed`,
    [
      operation,
      id,
      expectedVersion,
      draft?.name ?? null,
      draft?.tool ?? null,
      draft === null ? null : "0.1.0",
      draft === null ? null : JSON.stringify(draft.object_filter),
      draft === null ? null : JSON.stringify(draft.schedule),
      draft === null ? null : JSON.stringify(draft.limits),
      draft?.valid_from ?? null,
      draft?.valid_until ?? null,
    ],
  );
  return result.rows[0]?.changed === true;
}

export function createPgAutomationStore(): AutomationStore {
  const get = async (context: AutomationStoreContext, id: string) => {
    const result = await context.client.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS}
         FROM public.automation_policies policy_row
        WHERE policy_row.org_id = $1::uuid AND policy_row.store_id = $2::uuid
          AND policy_row.id = $3::uuid`,
      [...contextValues(context), id],
    );
    return result.rows[0] === undefined ? null : parsePolicy(result.rows[0]);
  };

  return Object.freeze({
    create: (context, id, draft) => writePolicy(context, "create", id, null, draft),
    update: (context, id, expectedVersion, draft) =>
      writePolicy(context, "update", id, expectedVersion, draft),
    transition: (
      context: AutomationStoreContext,
      id: string,
      expectedVersion: number,
      operation: AutomationTransition,
    ) => writePolicy(context, operation, id, expectedVersion, null),
    get,
    async list(context, status: AutomationPolicy["status"] | undefined, limit) {
      const result = await context.client.query<PolicyRow>(
        `SELECT ${POLICY_COLUMNS}
           FROM public.automation_policies policy_row
          WHERE policy_row.org_id = $1::uuid AND policy_row.store_id = $2::uuid
            AND ($3::text IS NULL OR policy_row.status = $3::text)
          ORDER BY policy_row.updated_at DESC, policy_row.id
          LIMIT $4::integer`,
        [...contextValues(context), status ?? null, limit],
      );
      return Object.freeze(result.rows.map(parsePolicy));
    },
    async listRuns(context, policyId, limit) {
      const result = await context.client.query<RunRow>(
        `SELECT log_row.id::text AS run_id, log_row.policy_id::text,
                log_row.tool, log_row.decision, log_row.outcome, log_row.args_sha256,
                log_row.object_count, log_row.amount_cents, log_row.error_code,
                log_row.started_at, log_row.completed_at
           FROM public.ai_action_log log_row
          WHERE log_row.org_id = $1::uuid AND log_row.store_id = $2::uuid
            AND log_row.policy_id = $3::uuid
          ORDER BY log_row.started_at DESC, log_row.id
          LIMIT $4::integer`,
        [...contextValues(context), policyId, limit],
      );
      return Object.freeze(result.rows.map(parseRun));
    },
    async listDue(context, now: Date, limit: number) {
      const result = await context.client.query<PolicyRow>(
        `SELECT ${POLICY_COLUMNS}
           FROM public.automation_due_policies($1::timestamptz, $2::integer) policy_row`,
        [now.toISOString(), limit],
      );
      return Object.freeze(result.rows.map(parsePolicy));
    },
    async beginAttempt(
      context,
      attempt: AutomationAttempt,
    ): Promise<AutomationAttemptAuthorization> {
      const result = await context.client.query<{ authorized: boolean; reason: string }>(
        `SELECT authorized, reason FROM public.automation_attempt_begin(
           $1::uuid, $2::integer, $3::uuid, $4::uuid, $5::integer,
           $6::integer, $7::text, $8::timestamptz
         )`,
        [
          attempt.policyId,
          attempt.policyVersion,
          attempt.runId,
          attempt.leaseToken,
          attempt.objectCount,
          attempt.amountCents,
          attempt.argsSha256,
          attempt.startedAt.toISOString(),
        ],
      );
      const row = result.rows[0];
      if (
        row === undefined ||
        !["AUTHORIZED", "POLICY_DENIED", "OUTSIDE_WINDOW", "QUOTA_EXCEEDED"].includes(row.reason)
      ) {
        throw new TypeError("Invalid automation attempt authorization result");
      }
      return Object.freeze({
        authorized: row.authorized,
        reason: row.reason as AutomationAttemptAuthorization["reason"],
      });
    },
    async settleAttempt(context, settlement: AutomationAttemptSettlement) {
      const result = await context.client.query<{ changed: boolean }>(
        `SELECT public.automation_attempt_settle(
           $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::integer,
           $7::integer, $8::text, $9::timestamptz, $10::timestamptz
         ) AS changed`,
        [
          settlement.policyId,
          settlement.runId,
          settlement.leaseToken,
          settlement.outcome,
          settlement.argsSha256,
          settlement.objectCount,
          settlement.amountCents,
          settlement.errorCode,
          settlement.startedAt.toISOString(),
          settlement.completedAt.toISOString(),
        ],
      );
      return result.rows[0]?.changed === true;
    },
    async recordAttempt(context, attempt: AutomationRecordOnlyAttempt) {
      const result = await context.client.query<{ changed: boolean }>(
        `SELECT public.automation_attempt_record(
           $1::uuid, $2::integer, $3::uuid, $4::text, $5::text, $6::text, $7::timestamptz
         ) AS changed`,
        [
          attempt.policyId,
          attempt.policyVersion,
          attempt.runId,
          attempt.outcome,
          attempt.argsSha256,
          attempt.errorCode,
          attempt.at.toISOString(),
        ],
      );
      return result.rows[0]?.changed === true;
    },
  });
}
