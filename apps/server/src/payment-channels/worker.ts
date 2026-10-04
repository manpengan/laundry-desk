import type { FastifyInstance } from "fastify";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { ByokKmsPort } from "../ai/byok-kms.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { safeErrorContext } from "../http/local-logger.js";
import { createChannelService } from "./service.js";
import { createChannelRefundService } from "./refund-service.js";
export function installChannelWorker(app: FastifyInstance, local: LocalRuntime, kms: ByokKmsPort) {
  const tenant = {
    orgId: LOCAL_PROFILE.orgId,
    storeId: LOCAL_PROFILE.storeId,
    staffId: LOCAL_PROFILE.adminStaffId,
  };
  const service = createChannelService(local, kms);
  const refunds = createChannelRefundService(local, kms);
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> | null = null;
  let stopped = false;
  const run = async () => {
    const tasks = await service.transact(tenant, ({ client }) =>
      claimChannelChecks(client, tenant),
    );
    for (const row of tasks.intents) {
      if (stopped) return;
      try {
        await service.sync(tenant, row.id);
      } catch (error) {
        app.log.error(safeErrorContext(error), "Payment receipt verification failed");
      }
    }
    for (const row of tasks.refunds) {
      if (stopped) return;
      try {
        await refunds.advance(tenant, row.id);
      } catch (error) {
        app.log.error(safeErrorContext(error), "Refund receipt verification failed");
      }
    }
  };
  const tick = () => {
    if (stopped || current !== null) return;
    current = run()
      .catch((error) =>
        app.log.error(safeErrorContext(error), "Payment reconciliation worker failed"),
      )
      .finally(() => {
        current = null;
      });
  };
  app.addHook("onReady", async () => {
    timer = setInterval(tick, 10_000);
    timer.unref();
    tick();
  });
  app.addHook("onClose", async () => {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    await current;
  });
}

/**
 * Polling backs off with age (10 s while a code can be paid, 1 min for the half hour
 * after expiry, then 10 min). An intent without a verified receipt that is still
 * unresolved a day after expiry waits for an administrator instead of polling forever.
 */
export async function claimChannelChecks(client: SqlClient, tenant: TenantContext) {
  return {
    intents: (
      await client.query<{ id: string }>(
        `WITH due AS (SELECT i.id FROM payment_channel_intents i
          JOIN payment_channel_settings s ON s.org_id=i.org_id AND s.store_id=i.store_id AND s.channel=i.channel
          WHERE i.org_id=$1::uuid AND i.store_id=$2::uuid AND i.state IN ('created','pending','unknown','needs_review')
          AND NOT (i.state='needs_review' AND i.provider_order IS NULL
            AND statement_timestamp() > i.expires_at + interval '24 hours')
          AND (i.checked_at IS NULL OR i.checked_at <= statement_timestamp() - CASE
            WHEN statement_timestamp() <= i.expires_at THEN interval '10 seconds'
            WHEN statement_timestamp() <= i.expires_at + interval '30 minutes' THEN interval '1 minute'
            ELSE interval '10 minutes' END)
          ORDER BY i.checked_at NULLS FIRST,i.id LIMIT 3 FOR UPDATE OF i SKIP LOCKED)
        UPDATE payment_channel_intents target SET checked_at=statement_timestamp() FROM due WHERE target.id=due.id RETURNING target.id`,
        [tenant.orgId, tenant.storeId],
      )
    ).rows,
    refunds: (
      await client.query<{ id: string }>(
        `WITH due AS (SELECT r.id FROM payment_channel_refunds r
          JOIN payment_channel_intents i ON i.org_id=r.org_id AND i.store_id=r.store_id AND i.id=r.intent_id
          JOIN payment_channel_settings s ON s.org_id=i.org_id AND s.store_id=i.store_id AND s.channel=i.channel
          WHERE r.org_id=$1::uuid AND r.store_id=$2::uuid AND r.state IN ('created','pending','unknown','needs_review')
          AND (r.checked_at IS NULL OR r.checked_at <= statement_timestamp() - CASE
            WHEN statement_timestamp() <= r.created_at + interval '30 minutes' THEN interval '10 seconds'
            WHEN statement_timestamp() <= r.created_at + interval '1 day' THEN interval '2 minutes'
            ELSE interval '30 minutes' END)
          ORDER BY r.checked_at NULLS FIRST,r.id LIMIT 3 FOR UPDATE OF r SKIP LOCKED)
        UPDATE payment_channel_refunds target SET checked_at=statement_timestamp() FROM due WHERE target.id=due.id RETURNING target.id`,
        [tenant.orgId, tenant.storeId],
      )
    ).rows,
  };
}
