import type { SqlClient, TenantContext } from "../db/types.js";
import { readIntent, channelAudit } from "./intent-store.js";
import type { ChannelProtocolError } from "./types.js";

const OPEN = ["created", "pending", "unknown", "needs_review"];

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

export type CloseReason =
  | "CHANNEL_NOT_SENT"
  | "CHANNEL_REJECTED"
  | "CHANNEL_EXPIRED"
  | "CHANNEL_CLOSED_BY_STAFF"
  | "CHANNEL_MANUAL_CLOSED";

/** error_code allows only [A-Z_]; keep the provider's code so staff can act on it. */
export function closeCode(reason: CloseReason, error?: ChannelProtocolError): string {
  const provider = error?.providerCode?.toUpperCase().replace(/[^A-Z_]/gu, "_") ?? "";
  return provider === "" ? reason : `${reason}_${provider}`.slice(0, 64);
}

/**
 * Ends a dispatched intent the provider can no longer collect: the request never left,
 * was definitively rejected, was closed/cancelled at the provider, or does not exist
 * there after expiry. A verified receipt (provider order or paid time) is never closed.
 */
export async function closeUnconfirmed(
  client: SqlClient,
  tenant: TenantContext,
  id: string,
  errorCode: string,
  detail: Readonly<Record<string, unknown>> = {},
): Promise<boolean> {
  const row = await readIntent(client, tenant, id, true);
  if (
    row === null ||
    !OPEN.includes(row.state) ||
    row.provider_order !== null ||
    row.paid_at !== null
  )
    return false;
  await client.query(
    `UPDATE payment_channel_intents SET state='closed',checkout_json=NULL,checked_at=statement_timestamp(),error_code=$4
    WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
    [tenant.orgId, tenant.storeId, id, errorCode],
  );
  await channelAudit(client, tenant, "payment.channel.close_unconfirmed", id, {
    previous_state: row.state,
    error_code: errorCode,
    ...detail,
  });
  return true;
}
