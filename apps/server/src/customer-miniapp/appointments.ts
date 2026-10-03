import {
  MINIAPP_TRANSACTION_SCHEMAS as S,
  MiniappAppointmentResultSchema,
} from "@laundry/contracts";
import { type Delegation, createMiniappDomainExecutor } from "./authority.js";
import { MiniappError, type MiniappTransaction } from "./types.js";
export async function mutateMiniappAppointment(
  tx: MiniappTransaction,
  authority: Delegation,
  action: "appointments/create" | "appointments/cancel",
  raw: unknown,
  execute: ReturnType<typeof createMiniappDomainExecutor>,
) {
  if (action === "appointments/create") {
    const { idempotency_key, ...input } = S[action].parse(raw);
    return MiniappAppointmentResultSchema.parse(
      await execute(
        tx,
        authority,
        "delivery.appointment.create",
        { ...input, customer_id: tx.customerId },
        idempotency_key,
      ),
    );
  }
  const input = S[action].parse(raw);
  const row = (
    await tx.client.query<{ customer_id: string }>(
      `SELECT customer_id::text FROM delivery_appointments WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    AND customer_canonical_root(customer_id)=$4::uuid FOR UPDATE`,
      [tx.tenant.orgId, tx.tenant.storeId, input.appointment_id, tx.customerId],
    )
  ).rows[0];
  if (row === undefined) throw new MiniappError("RESOURCE_UNAVAILABLE");
  return MiniappAppointmentResultSchema.parse(
    await execute(
      tx,
      authority,
      "delivery.appointment.cancel",
      {
        customer_id: row.customer_id,
        appointment_id: input.appointment_id,
        expected_version: input.expected_version,
        reason: "customer_request",
      },
      input.idempotency_key,
    ),
  );
}
