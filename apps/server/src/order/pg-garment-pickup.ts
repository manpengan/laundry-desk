import type { SqlClient } from "../db/types.js";
import { epochToDate } from "./pg-order-mappers.js";
import type { GarmentRecord, OrderRecord, PickupApplyOptions } from "./types.js";

type MarkGarmentsPickedUpInput = Readonly<{
  orgId: string;
  storeId: string;
  orderId: string;
  garmentIds: readonly string[];
  garments: readonly GarmentRecord[];
  staffId: string | undefined;
  nowEpoch: number;
  newId: () => string;
}>;

export async function markGarmentsPickedUp(
  client: SqlClient,
  input: MarkGarmentsPickedUpInput,
): Promise<void> {
  await client.query(
    `UPDATE garments
     SET status = 'picked_up',
         rack_zone = NULL,
         rack_slot = NULL,
         racked_at = NULL,
         racked_by_staff_id = NULL
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid
       AND id = ANY($4::uuid[])`,
    [input.orgId, input.storeId, input.orderId, [...input.garmentIds]],
  );
  if (input.staffId === undefined) return;

  const idSet = new Set(input.garmentIds);
  const pickedRows = input.garments.filter((garment) => idSet.has(garment.garment_id));
  for (const garment of pickedRows) {
    await client.query(
      `INSERT INTO garment_status_log (
         id, org_id, store_id, order_id, garment_id,
         from_status, to_status, reason, staff_id, at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 $6, 'picked_up', 'pickup_verified', $7::uuid, $8)`,
      [
        input.newId(),
        input.orgId,
        input.storeId,
        input.orderId,
        garment.garment_id,
        garment.status,
        input.staffId,
        epochToDate(input.nowEpoch),
      ],
    );
  }
}

export function assertPickupPlanMatchesCurrentRows(
  options: PickupApplyOptions | undefined,
  balanceCents: number,
  nextStatus: OrderRecord["status"],
): void {
  if (options?.nextBalanceCents !== undefined && options.nextBalanceCents !== balanceCents) {
    throw new Error("Pickup plan balance no longer matches persisted order");
  }
  if (options?.nextOrderStatus !== undefined && options.nextOrderStatus !== nextStatus) {
    throw new Error("Pickup plan status no longer matches persisted order");
  }
}
