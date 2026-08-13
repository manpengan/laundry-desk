import type {
  MarketingGroupBuyRegistrationAuthority,
  MarketingGroupBuyVoucher,
} from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";
import { sameGroupBuyRegistrationAuthority } from "./extension-authority.js";
import type {
  MarketingExtensionRejectReason,
  MarketingExtensionStore,
  MarketingGroupBuyRegistrationAuthorityResult,
  MarketingGroupBuyRegistrationResult,
} from "./extension-types.js";
import { marketingInteger, marketingTimestamp } from "./pg-extension-support.js";

type VoucherRow = Readonly<{
  voucher_id: string;
  provider: "meituan" | "douyin" | "wechat" | "other";
  external_order_ref: string;
  code_digest: string;
  code_last4: string;
  label: string;
  face_value_cents: number | string;
  expires_at: Date | string;
  reason: string;
  registered_at: Date | string;
}>;

const failure = (reason: MarketingExtensionRejectReason) => Object.freeze({ ok: false, reason });

function wireVoucher(row: VoucherRow, replayed: boolean): MarketingGroupBuyVoucher {
  return Object.freeze({
    voucher_id: row.voucher_id,
    provider: row.provider,
    external_order_ref: row.external_order_ref,
    code_last4: row.code_last4,
    label: row.label,
    face_value_cents: marketingInteger(row.face_value_cents, "voucher face value"),
    expires_at: marketingTimestamp(row.expires_at, "voucher expiry"),
    registered_at: marketingTimestamp(row.registered_at, "voucher registration"),
    replayed,
  });
}

async function findVouchers(
  client: SqlClient,
  tenant: TenantContext,
  digest: string,
  provider: string,
  externalRef: string,
): Promise<readonly VoucherRow[]> {
  const result = await client.query<VoucherRow>(
    `SELECT id::text AS voucher_id, provider, external_order_ref, code_digest,
            code_last4, label, face_value_cents, expires_at, reason, registered_at
       FROM group_buy_vouchers
      WHERE org_id=$1::uuid AND store_id=$2::uuid
        AND (code_digest=$3 OR (provider=$4 AND external_order_ref=$5))
      ORDER BY id`,
    [tenant.orgId, tenant.storeId, digest, provider, externalRef],
  );
  return Object.freeze(result.rows);
}

function registrationMatches(
  row: VoucherRow,
  authority: MarketingGroupBuyRegistrationAuthority,
): boolean {
  return (
    row.code_digest === authority.code_digest &&
    row.provider === authority.provider &&
    row.external_order_ref === authority.external_order_ref &&
    row.code_last4 === authority.code_last4 &&
    row.label === authority.label &&
    marketingInteger(row.face_value_cents, "voucher face value") === authority.face_value_cents &&
    marketingTimestamp(row.expires_at, "voucher expiry") === authority.expires_at &&
    row.reason === authority.reason
  );
}

async function registrationAuthority(
  client: SqlClient,
  tenant: TenantContext,
  input: Parameters<MarketingExtensionStore["previewGroupBuyRegistration"]>[2],
): Promise<MarketingGroupBuyRegistrationAuthorityResult> {
  const authority: MarketingGroupBuyRegistrationAuthority = Object.freeze({
    kind: "marketing_group_buy_registration",
    code_digest: input.voucher_code_digest,
    code_last4: input.voucher_code_last4,
    provider: input.provider,
    external_order_ref: input.external_order_ref,
    label: input.label,
    face_value_cents: input.face_value_cents,
    expires_at: input.expires_at,
    reason: input.reason,
  });
  const existing = await findVouchers(
    client,
    tenant,
    authority.code_digest,
    authority.provider,
    authority.external_order_ref,
  );
  if (
    existing.length > 1 ||
    (existing[0] !== undefined && !registrationMatches(existing[0], authority))
  ) {
    return failure("voucher_conflict");
  }
  if (existing[0] === undefined) {
    const expires = new Date(input.expires_at);
    const maxExpiry = new Date(input.at);
    maxExpiry.setUTCFullYear(maxExpiry.getUTCFullYear() + 5);
    if (expires <= input.at || expires > maxExpiry) return failure("voucher_expired");
  }
  return Object.freeze({ ok: true, authority });
}

async function registerVoucher(
  client: SqlClient,
  tenant: TenantContext,
  input: Parameters<MarketingExtensionStore["registerGroupBuyVoucher"]>[2],
  newId: () => string,
): Promise<MarketingGroupBuyRegistrationResult> {
  const resolved = await registrationAuthority(client, tenant, input);
  if (!resolved.ok) return resolved;
  if (!sameGroupBuyRegistrationAuthority(resolved.authority, input.frozenAuthority)) {
    return failure("authority_drift");
  }
  const existing = await findVouchers(
    client,
    tenant,
    resolved.authority.code_digest,
    input.provider,
    input.external_order_ref,
  );
  if (existing[0] !== undefined) {
    return Object.freeze({ ok: true, voucher: wireVoucher(existing[0], true) });
  }
  const inserted = await client.query<VoucherRow>(
    `INSERT INTO group_buy_vouchers
       (id, org_id, store_id, provider, external_order_ref, code_digest, code_last4,
        label, face_value_cents, expires_at, reason, registered_by_staff_id, registered_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT DO NOTHING
     RETURNING id::text AS voucher_id, provider, external_order_ref, code_digest,
       code_last4, label, face_value_cents, expires_at, reason, registered_at`,
    [
      newId(),
      tenant.orgId,
      tenant.storeId,
      input.provider,
      input.external_order_ref,
      resolved.authority.code_digest,
      resolved.authority.code_last4,
      input.label,
      input.face_value_cents,
      input.expires_at,
      input.reason,
      tenant.staffId,
      input.at.toISOString(),
    ],
  );
  const row = inserted.rows[0];
  if (row !== undefined) return Object.freeze({ ok: true, voucher: wireVoucher(row, false) });
  const raced = await findVouchers(
    client,
    tenant,
    resolved.authority.code_digest,
    input.provider,
    input.external_order_ref,
  );
  if (raced.length !== 1 || !registrationMatches(raced[0]!, resolved.authority)) {
    return failure("voucher_conflict");
  }
  return Object.freeze({ ok: true, voucher: wireVoucher(raced[0]!, true) });
}

export function createPgMarketingGroupBuyRegistrationOperations(
  newId: () => string,
): Pick<MarketingExtensionStore, "previewGroupBuyRegistration" | "registerGroupBuyVoucher"> {
  return Object.freeze({
    previewGroupBuyRegistration: (client, tenant, input) =>
      registrationAuthority(client, tenant, input),
    registerGroupBuyVoucher: (client, tenant, input) =>
      registerVoucher(client, tenant, input, newId),
  });
}
