import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MINIAPP_TRANSACTION_SCHEMAS as S,
  MiniappSubscriptionInputSchema,
  type MiniappTransactionAction,
} from "@laundry/contracts";
import type { LocalRuntime } from "../local/runtime-types.js";
import type { ByokKmsPort } from "../ai/byok-kms.js";
import { runWithActiveTenantTransaction } from "../db/active-tenant-transaction.js";
import { readPortalProfile } from "../customer-self-service/pg-projections.js";
import { createChannelService } from "../payment-channels/service.js";
import { createMiniappDomainExecutor, delegation, miniappAudit } from "./authority.js";
import {
  createMiniappPayment,
  applyMiniappBenefit,
  ownedIntent,
  miniappIntentView,
} from "./money.js";
import { mutateMiniappAppointment } from "./appointments.js";
import { miniappOptions, miniappAppointments, miniappPayments, queryMiniapp } from "./queries.js";
import { updateMiniappProfile } from "./profile.js";
import { MiniappError, type MiniappTransaction } from "./types.js";
import type { MiniappIdentityService } from "./identity.js";

function profileKey(customer: string, version: number) {
  const hex = createHash("sha256").update(`miniapp-profile:${customer}:${version}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const requiredPermission = (action: string) =>
  action.startsWith("appointments/")
    ? "delivery_write"
    : action === "profile/update" || action === "topup/create"
      ? "customer_write"
      : "order_write";
export function createMiniappService(
  local: LocalRuntime,
  kms: ByokKmsPort | null,
  identity: MiniappIdentityService,
  channels = createChannelService(local, kms),
) {
  const execute = createMiniappDomainExecutor(local);
  const mutate = async (tx: MiniappTransaction, action: MiniappTransactionAction, raw: unknown) => {
    const input = S[action].parse(raw);
    const authority = await delegation(tx);
    if (!(authority.actor.permissions ?? []).includes(requiredPermission(action)))
      throw new MiniappError("PERMISSION_DENIED");
    const key =
      "idempotency_key" in input
        ? input.idempotency_key
        : action === "profile/update"
          ? profileKey(tx.customerId, S["profile/update"].parse(raw).expected_version)
          : null;
    if (key === null) throw new MiniappError("VALIDATION_FAILED");
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    await tx.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,88))", [
      `${tx.tenant.orgId}:${tx.customerId}:${action}:${key}`,
    ]);
    const previous = (
      await tx.client.query<{ input_sha256: string; result_json: unknown }>(
        `SELECT input_sha256,result_json FROM miniapp_transaction_receipts
      WHERE org_id=$1::uuid AND store_id=$2::uuid AND customer_canonical_root(customer_id)=$3::uuid AND action=$4 AND idempotency_key=$5::uuid`,
        [tx.tenant.orgId, tx.tenant.storeId, tx.customerId, action, key],
      )
    ).rows[0];
    if (previous !== undefined) {
      if (previous.input_sha256 !== hash) throw new MiniappError("IDEMPOTENCY_CONFLICT");
      return { result: previous.result_json, tenant: authority.tenant };
    }
    const result = await runWithActiveTenantTransaction(
      { client: tx.client, tenant: authority.tenant },
      async () => {
        if (action === "appointments/create" || action === "appointments/cancel")
          return mutateMiniappAppointment(tx, authority, action, input, execute);
        if (action === "payment/create" || action === "topup/create")
          return createMiniappPayment(tx, authority, action, input);
        if (action === "profile/update")
          return updateMiniappProfile(
            tx,
            S["profile/update"].parse(input),
            local.accessTokenSecret,
          );
        return applyMiniappBenefit(tx, authority, action, input, execute);
      },
    );
    const id = randomUUID();
    await tx.client.query(
      `INSERT INTO miniapp_transaction_receipts(id,org_id,store_id,customer_id,session_id,delegated_staff_id,config_version,permission_version,action,idempotency_key,input_sha256,result_json)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,$10::uuid,$11,$12::jsonb)`,
      [
        id,
        tx.tenant.orgId,
        tx.tenant.storeId,
        tx.customerId,
        tx.identity.sessionId,
        authority.actor.staffId,
        tx.settings.version,
        authority.permissionVersion,
        action,
        key,
        hash,
        JSON.stringify(result),
      ],
    );
    await miniappAudit(tx, authority, action, id);
    return { result, tenant: authority.tenant };
  };
  return Object.freeze({
    query: (token: string, raw: unknown) => identity.transact(token, (tx) => queryMiniapp(tx, raw)),
    async transaction(
      token: string,
      action: MiniappTransactionAction,
      raw: unknown,
    ): Promise<unknown> {
      S[action].parse(raw);
      if (action === "options") return identity.transact(token, (tx) => miniappOptions(local, tx));
      if (action === "appointments/list") return identity.transact(token, miniappAppointments);
      if (action === "payment/list") return identity.transact(token, miniappPayments);
      if (action === "payment/status") {
        const input = S[action].parse(raw);
        const authorized = await identity.transact(token, async (tx) => {
          await ownedIntent(tx, input.intent_id);
          return delegation(tx);
        });
        await channels.sync(authorized.tenant, input.intent_id);
        return identity.transact(token, async (tx) =>
          miniappIntentView(await ownedIntent(tx, input.intent_id)),
        );
      }
      const completed = await identity.transact(token, (tx) => mutate(tx, action, raw));
      if (action === "profile/update")
        return identity.transact(token, (tx) => readPortalProfile(tx.raw));
      if (action === "payment/create" || action === "topup/create") {
        const intentId = z.object({ intent_id: z.uuid() }).parse(completed.result).intent_id;
        const current = await identity.transact(token, async (tx) => {
          await ownedIntent(tx, intentId);
          return tx.identity;
        });
        await channels.dispatch(completed.tenant, intentId, current.openId);
        return identity.transact(token, async (tx) =>
          miniappIntentView(await ownedIntent(tx, intentId)),
        );
      }
      return completed.result;
    },
    async subscribe(token: string, raw: unknown) {
      const input = MiniappSubscriptionInputSchema.parse(raw);
      return identity.transact(token, async (tx) => {
        if (
          input.template_ids.some((id) => !tx.settings.subscription_template_ids.includes(id)) ||
          new Set(input.template_ids).size !== input.template_ids.length
        )
          throw new MiniappError("VALIDATION_FAILED");
        for (const template of input.template_ids)
          await tx.client.query(
            `INSERT INTO miniapp_subscriptions(id,org_id,store_id,customer_id,session_id,template_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6)`,
            [
              randomUUID(),
              tx.tenant.orgId,
              tx.tenant.storeId,
              tx.customerId,
              tx.identity.sessionId,
              template,
            ],
          );
        return { recorded: true as const };
      });
    },
  });
}
