import type { V2MigrationPlan } from "@laundry/migrate-v1/plan";
import type { LegacyRecord } from "./import-legacy.js";

/** Historical evidence is never used to authorize staff or deliver old messages.
 * Audit text may mention multiple people; privacy deletion conservatively erases
 * the organization's entire imported audit history. */
export function legacyHistoryRecords(
  plan: V2MigrationPlan,
  batchId: string,
  idFor: (value: string) => string,
): readonly LegacyRecord[] {
  const history = plan.sourceSnapshot.history;
  if (!history) return [];
  const row = (
    type: string,
    id: number,
    customerId: string | null,
    metadata: Readonly<Record<string, unknown>>,
  ): LegacyRecord => {
    const entityId = idFor(`${batchId}:${type}:${id}`);
    return {
      id: entityId,
      batch_id: batchId,
      entity_type: type,
      entity_id: entityId,
      customer_id: customerId,
      metadata,
    };
  };
  return [
    ...history.staffs.map((staff) =>
      row("legacy_staff", staff.id, null, { ...staff, credentials_excluded: true }),
    ),
    ...history.sms.map((sms) => {
      const order = plan.orders.find((candidate) => candidate.legacyOrderId === sms.order_id);
      const customer = plan.customers.find((candidate) => candidate.phone === sms.phone);
      if (order && customer && order.customerId !== customer.id)
        throw new Error("V1_MIGRATION_SMS_SUBJECT_CONFLICT");
      return row("legacy_sms", sms.id, order?.customerId ?? customer?.id ?? null, { ...sms });
    }),
    ...history.audit.map((audit) => row("legacy_audit", audit.id, null, { ...audit })),
  ];
}

export function migrationHistorySummary(plan: V2MigrationPlan) {
  const history = plan.sourceSnapshot.history;
  return {
    staffs: history?.staffs.length ?? 0,
    sms: history?.sms.length ?? 0,
    audit: history?.audit.length ?? 0,
    excluded_credentials: history?.excluded_credential_count ?? 0,
    privacy_policy: "erase_all_imported_audit_and_unowned_sms_on_customer_erasure" as const,
  };
}
