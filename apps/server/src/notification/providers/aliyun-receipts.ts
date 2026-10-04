import type { PgPool } from "../../db/pg-pool.js";
import { withPoolClient } from "../../db/pg-sql-client.js";
import { withWorkerTenantTransaction } from "../../db/worker-transaction.js";
import type { TenantContext } from "../../db/types.js";
import type { NotificationWorkerStore } from "../delivery-types.js";
import type { createAliyunSmsClient } from "./aliyun-client.js";

type ReceiptTarget = Readonly<{
  id: string;
  phone: string;
  provider_code: string;
  accepted_at: Date | string;
}>;
const sendDate = (date: Date) =>
  new Date(date.getTime() + 8 * 3_600_000).toISOString().slice(0, 10).replaceAll("-", "");

/** Poll only server-scoped accepted deliveries whose current recipient still matches the frozen HMAC. */
export async function reconcileAliyunReceipts(
  options: Readonly<{
    pool: PgPool;
    tenant: TenantContext;
    store: NotificationWorkerStore;
    client: ReturnType<typeof createAliyunSmsClient>;
    templateCode: string;
  }>,
) {
  const targets = await withPoolClient(options.pool, (client) =>
    withWorkerTenantTransaction(client, options.tenant, async (transaction) => {
      const rows = (
        await transaction.query<ReceiptTarget>(
          `SELECT d.id,c.phone,b.provider_code,d.accepted_at FROM notification_deliveries d
         JOIN notification_delivery_batches b ON b.org_id=d.org_id AND b.store_id=d.store_id AND b.id=d.batch_id
         JOIN customers c ON c.org_id=d.org_id AND c.id=d.customer_id
         WHERE d.org_id=$1::uuid AND d.store_id=$2::uuid AND d.status='accepted'
           AND b.provider_code ~ '^aliyun_sms_v[0-9]+$'
           AND notification_recipient_matches(d.org_id,d.store_id,d.order_id,d.customer_id,d.recipient_hmac)
         ORDER BY d.receipt_checked_at NULLS FIRST,d.updated_at,d.id LIMIT 5 FOR UPDATE OF d SKIP LOCKED`,
          [options.tenant.orgId, options.tenant.storeId],
        )
      ).rows;
      if (rows.length > 0)
        await transaction.query(
          "UPDATE notification_deliveries SET receipt_checked_at=statement_timestamp() WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=ANY($3::uuid[])",
          [options.tenant.orgId, options.tenant.storeId, rows.map((row) => row.id)],
        );
      return rows;
    }),
  );
  for (const target of targets) {
    const acceptedAt = new Date(target.accepted_at);
    const dates = [
      ...new Set([sendDate(acceptedAt), sendDate(new Date(acceptedAt.getTime() - 10_000))]),
    ];
    for (const date of dates) {
      const status = await options.client.query(
        {
          phone: target.phone,
          deliveryId: target.id,
          templateCode: options.templateCode,
          sendDate: date,
        },
        AbortSignal.timeout(10_000),
      );
      if (status === "delivered" || status === "failed") {
        const now = new Date();
        await options.store.applyReceipt(options.tenant, {
          deliveryId: target.id,
          providerCode: target.provider_code,
          receiptId: `aliyun:${target.id}:${status}`,
          status,
          observedAt: now,
          recordedAt: now,
        });
        break;
      }
    }
  }
}
