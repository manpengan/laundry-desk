import {
  CUSTOMER_SELF_SERVICE_QUERIES,
  MiniappQueryInputSchema,
  MiniappOptionsSchema,
  MiniappAppointmentsSchema,
  MiniappPaymentListSchema,
  parseContractInput,
} from "@laundry/contracts";
import type { LocalRuntime } from "../local/runtime-types.js";
import { readCustomerPortalProjection } from "../customer-self-service/pg-store.js";
import { readActiveBonusRules } from "../member/pg-bonus-rules.js";
import {
  APPOINTMENT_COLUMNS,
  mapAppointment,
  type AppointmentRow,
} from "../delivery-appointments/pg-support.js";
import type { ChannelIntent } from "../payment-channels/intent-store.js";
import { miniappIntentView } from "./money.js";
import { MiniappError, type MiniappTransaction } from "./types.js";
export async function queryMiniapp(tx: MiniappTransaction, raw: unknown) {
  const input = MiniappQueryInputSchema.parse(raw);
  const query = CUSTOMER_SELF_SERVICE_QUERIES.find((row) => row.name === input.name);
  if (query === undefined) throw new MiniappError("VALIDATION_FAILED");
  const result = await readCustomerPortalProjection(
    tx.raw,
    input.name,
    await parseContractInput(query, input.input),
  );
  if (result === null) throw new MiniappError("RESOURCE_UNAVAILABLE");
  return { execution: "executed" as const, result };
}
export async function miniappOptions(local: LocalRuntime, tx: MiniappTransaction) {
  const feature = await local.deliveryPolicy.featureEnabled(tx.client, tx.tenant);
  const rules = await readActiveBonusRules(tx.client, tx.tenant);
  const payment = (
    await tx.client.query<{ enabled: boolean; app_id: string }>(
      `SELECT enabled,app_id FROM payment_channel_settings WHERE org_id=$1::uuid AND store_id=$2::uuid AND channel='wechat'`,
      [tx.tenant.orgId, tx.tenant.storeId],
    )
  ).rows[0];
  const staff =
    tx.settings.delegated_staff_id === null
      ? null
      : (
          await tx.client.query(
            `SELECT 1 FROM staffs s JOIN staff_store_roles r ON r.org_id=s.org_id AND r.staff_id=s.id
    WHERE s.org_id=$1::uuid AND s.id=$2::uuid AND s.is_active AND r.store_id=$3::uuid AND r.is_active`,
            [tx.tenant.orgId, tx.settings.delegated_staff_id, tx.tenant.storeId],
          )
        ).rows[0];
  return MiniappOptionsSchema.parse({
    timezone: await local.deliveryPolicy.timeZone(tx.client, tx.tenant),
    delivery_policy: feature
      ? await local.deliveryPolicy.store.get(tx.tenant.orgId, tx.tenant.storeId)
      : null,
    topup_bonus_rules: rules.map(({ min_topup_cents, bonus_cents }) => ({
      min_topup_cents,
      bonus_cents,
    })),
    wechat_pay_enabled: payment?.enabled === true && payment.app_id === tx.settings.app_id,
    delegation_enabled: tx.settings.transactions_enabled && staff !== null && staff !== undefined,
  });
}
export async function miniappAppointments(tx: MiniappTransaction) {
  const rows = await tx.client.query<AppointmentRow>(
    `SELECT ${APPOINTMENT_COLUMNS} FROM delivery_appointments WHERE org_id=$1::uuid AND store_id=$2::uuid
    AND customer_canonical_root(customer_id)=$3::uuid ORDER BY created_at DESC,id DESC LIMIT 100`,
    [tx.tenant.orgId, tx.tenant.storeId, tx.customerId],
  );
  return MiniappAppointmentsSchema.parse({ appointments: rows.rows.map(mapAppointment) });
}
export async function miniappPayments(tx: MiniappTransaction) {
  const rows = await tx.client.query<ChannelIntent>(
    `SELECT * FROM payment_channel_intents WHERE org_id=$1::uuid AND store_id=$2::uuid AND customer_canonical_root(customer_id)=$3::uuid
    AND channel='wechat' AND customer_session_id IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 20`,
    [tx.tenant.orgId, tx.tenant.storeId, tx.customerId],
  );
  return MiniappPaymentListSchema.parse({
    intents: rows.rows.map((row) => miniappIntentView(row)),
  });
}
