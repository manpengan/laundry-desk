import type { SqlClient, TenantContext } from "../db/types.js";
import { readIntent, channelAudit } from "./intent-store.js";
/** Never cancel a request whose provider may have received it, or a verified receipt. */
export async function closeUndispatched(
  client: SqlClient,
  tenant: TenantContext,
  id: string,
  expiredOnly: boolean,
) {
  const row = await readIntent(client, tenant, id, true);
  if (
    row === null ||
    !["created", "needs_review"].includes(row.state) ||
    row.dispatched_at !== null ||
    row.provider_order !== null ||
    row.paid_at !== null ||
    (expiredOnly && row.expires_at.getTime() > Date.now())
  )
    return;
  await client.query(
    `UPDATE payment_channel_intents SET state='closed',checkout_json=NULL,checked_at=statement_timestamp(),error_code=NULL WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
    [tenant.orgId, tenant.storeId, id],
  );
  await channelAudit(client, tenant, "payment.channel.close_undispatched", id, {
    previous_state: row.state,
    reason: expiredOnly ? "expired" : "administrator_close",
  });
}
