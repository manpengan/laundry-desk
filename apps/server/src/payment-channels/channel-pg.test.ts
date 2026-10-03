import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPgPool, resolvePgUrls, withClient } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { seedMigrationTenant } from "../data-transfer/import-test-fixture.js";
import { createMemoryLocalRuntime } from "../local/demo-seed.js";
import { encryptCredential } from "../ai/byok-envelope.js";
import type { ByokKmsPort } from "../ai/byok-kms.js";
import { serializeEnvelope } from "../notification/providers/credential-envelope.js";
import { createChannelService } from "./service.js";
import { insertIntent } from "./intent-store.js";
import { accountFingerprint } from "./settings.js";
import { channelFixture } from "./protocol-fixture.js";
import { claimChannelChecks } from "./worker.js";
import { queueChannelRefund } from "./refund-store.js";
import { settleChannelRefund } from "./refund-settlement.js";
import { appendRefundTxn } from "../order/pg-order-refund.js";
import { createPgMemberStore } from "../member/pg-store.js";
import { ChannelRefundViewSchema } from "@laundry/contracts";
import { reconcileChannelBill } from "./reconciliation.js";
import { settleChannelPayment } from "./settlement.js";

const urls = resolvePgUrls();
const kms: ByokKmsPort = {
  wrapDataKey: async ({ plaintextKey }) => ({
    wrappedKey: Buffer.from(plaintextKey),
    keyId: "windows-dpapi-current-user",
    keyVersion: "1",
  }),
  unwrapDataKey: async ({ wrappedKey }) => Buffer.from(wrappedKey),
};
test(
  "real PG channel settlement reserves orders, isolates tenants and applies one ledger with its audit",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin });
    const pool = createPgPool({ connectionString: urls.app });
    const tenant = await seedMigrationTenant(admin);
    const other = await seedMigrationTenant(admin);
    const fixture = channelFixture();
    const base = await createMemoryLocalRuntime();
    const local = {
      ...base,
      mode: "pg" as const,
      pool,
      order: { ...base.order, isBusinessDayClosed: async () => false },
    };
    const transact = <T>(run: (client: import("../db/types.js").SqlClient) => Promise<T>) =>
      withClient(pool, (client) => withTenantTransaction(client, tenant, run));
    try {
      const credentialId = randomUUID();
      const envelope = serializeEnvelope(
        await encryptCredential(
          kms,
          { orgId: tenant.orgId, providerCode: "payment_wechat", credentialId },
          Buffer.from(JSON.stringify(fixture.wechat)),
        ),
      );
      await transact((client) =>
        client.query(
          `INSERT INTO payment_channel_settings(org_id,store_id,channel,version,enabled,app_id,merchant_id,account_fingerprint,credential_id,envelope_json,updated_by)
      VALUES($1,$2,'wechat',1,true,$3,$4,$5,$6,$7,$8)`,
          [
            tenant.orgId,
            tenant.storeId,
            fixture.wechat.appId,
            fixture.wechat.merchantId,
            accountFingerprint(fixture.wechat),
            credentialId,
            envelope,
            tenant.staffId,
          ],
        ),
      );
      const customerId = randomUUID();
      let orderIndex = 100000;
      const newOrder = async (amount = 1234) => {
        const id = randomUUID();
        await transact((client) =>
          client.query(
            `INSERT INTO orders(id,org_id,store_id,ticket_no,pickup_code,status,customer_id,subtotal_cents,original_cents,payable_cents,paid_cents,balance_cents,
        created_at,updated_at,created_by_staff_id,business_date) VALUES($1::uuid,$2::uuid,$3::uuid,$1::text,$7,'open',$4,$5,$5,$5,0,$5,now(),now(),$6,'2026-10-03')`,
            [
              id,
              tenant.orgId,
              tenant.storeId,
              customerId,
              amount,
              tenant.staffId,
              String(++orderIndex),
            ],
          ),
        );
        return id;
      };
      await transact((client) =>
        client.query(
          "INSERT INTO customers(id,org_id,phone,name,created_at,updated_at) VALUES($1,$2,'13800000001','虚构渠道顾客',now(),now())",
          [customerId, tenant.orgId],
        ),
      );
      const orderId = await newOrder();
      const input = {
        idempotencyKey: randomUUID(),
        channel: "wechat" as const,
        purpose: "order" as const,
        orderId,
        accountId: null,
        customerId: null,
      };
      const intent = await transact((client) => insertIntent(client, tenant, input));
      assert.equal((await transact((client) => insertIntent(client, tenant, input))).id, intent.id);
      await assert.rejects(
        transact((client) =>
          insertIntent(client, tenant, { ...input, idempotencyKey: randomUUID() }),
        ),
        /RESOURCE_UNAVAILABLE/u,
      );
      await assert.rejects(
        transact((client) => insertIntent(client, tenant, { ...input, channel: "alipay" })),
        /IDEMPOTENCY_CONFLICT/u,
      );
      await assert.rejects(
        transact((client) =>
          client.query("UPDATE orders SET status='cancelled' WHERE id=$1", [orderId]),
        ),
        /CHANNEL_PAYMENT_PENDING/u,
      );
      await assert.rejects(
        transact((client) =>
          client.query("UPDATE payment_channel_intents SET amount_cents=1 WHERE id=$1", [
            intent.id,
          ]),
        ),
        /CHANNEL_INTENT_IDENTITY_IMMUTABLE/u,
      );
      const invisible = await withClient(pool, (client) =>
        withTenantTransaction(client, other, (tx) =>
          tx.query("SELECT id FROM payment_channel_intents"),
        ),
      );
      assert.equal(invisible.rows.length, 0);
      const payment = {
        merchantOrder: intent.merchant_order,
        providerOrder: "provider_transaction_1",
        state: "paid" as const,
        amountCents: 1234,
        paidAt: new Date(),
      };
      await assert.rejects(
        transact((client) =>
          settleChannelPayment(client, tenant, local, intent.id, { ...payment, amountCents: 1 }),
        ),
        /CHANNEL_BINDING_MISMATCH/u,
      );
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          transact((client) => settleChannelPayment(client, tenant, local, intent.id, payment)),
        ),
      );
      assert.ok(results.every((row) => row.state === "paid"));
      assert.equal(new Set(results.map((row) => row.payment_id)).size, 1);
      const counts = await admin.query<{
        payments: number;
        audit: number;
        paid: number;
        balance: number;
      }>(
        `SELECT
      (SELECT count(*)::int FROM payments WHERE order_id=$1) AS payments,
      (SELECT count(*)::int FROM audit_log WHERE entity_id=$2 AND command='payment.channel.settle') AS audit,
      paid_cents AS paid,balance_cents AS balance FROM orders WHERE id=$1`,
        [orderId, intent.id],
      );
      assert.deepEqual(counts.rows[0], { payments: 1, audit: 1, paid: 1234, balance: 0 });
      await assert.rejects(
        transact((client) =>
          client.query(
            "UPDATE payment_channel_intents SET state='unknown',payment_id=NULL WHERE id=$1",
            [intent.id],
          ),
        ),
        /CHANNEL_INTENT_TERMINAL/u,
      );

      const queue = async (intentId: string, amount = 300) =>
        transact(async (client) =>
          ChannelRefundViewSchema.parse(
            (
              await queueChannelRefund({
                client,
                tenant,
                actor: {
                  staffId: tenant.staffId!,
                  deviceId: null,
                  via: "ui",
                  permissions: ["member_refund"],
                },
                request: {
                  name: "payment.channel.refund",
                  version: "1.0.0",
                  input: {},
                  dryRun: false,
                  idempotencyKey: randomUUID(),
                },
                parsed: { intent_id: intentId, amount_cents: amount, reason: "customer_request" },
              })
            ).result,
          ),
        );
      const refund = await queue(intent.id);
      await assert.rejects(queue(intent.id, 1000));
      await assert.rejects(
        transact((client) =>
          appendRefundTxn(
            client,
            {
              org_id: tenant.orgId,
              store_id: tenant.storeId,
              order_id: orderId,
              amount_cents: 100,
              expected_method: "wechat",
              ref_payment_id: results[0]!.payment_id!,
              reason: "manual",
              staff_id: tenant.staffId!,
              at: Math.floor(Date.now() / 1000),
              business_date: "2026-10-03",
            },
            randomUUID,
          ),
        ),
        /CHANNEL_REFUND_REQUIRED/u,
      );
      const refundRow = (
        await transact((client) =>
          client.query<{ merchant_refund: string }>(
            "SELECT merchant_refund FROM payment_channel_refunds WHERE id=$1",
            [refund.refund_id],
          ),
        )
      ).rows[0]!;
      const receipt = {
        merchantOrder: intent.merchant_order,
        merchantRefund: refundRow.merchant_refund,
        providerRefund: "provider_refund_1",
        amountCents: 300,
        state: "refunded" as const,
      };
      await assert.rejects(
        transact((client) =>
          settleChannelRefund(client, tenant, local, refund.refund_id, {
            ...receipt,
            amountCents: 301,
          }),
        ),
        /CHANNEL_BINDING_MISMATCH/u,
      );
      const refunded = await Promise.all(
        [1, 2].map(() =>
          transact((client) =>
            settleChannelRefund(client, tenant, local, refund.refund_id, receipt),
          ),
        ),
      );
      assert.ok(refunded.every((row) => row.state === "refunded"));
      assert.equal(new Set(refunded.map((row) => row.payment_id)).size, 1);
      assert.equal(
        (
          await admin.query<{ paid: number }>("SELECT paid_cents AS paid FROM orders WHERE id=$1", [
            orderId,
          ])
        ).rows[0]?.paid,
        934,
      );
      const reconciliation = await transact((client) =>
        reconcileChannelBill(client, tenant, {
          channel: "wechat",
          business_date: "2026-10-03",
          rows: [
            {
              merchant_order: intent.merchant_order,
              provider_order: payment.providerOrder,
              amount_cents: 1234,
              kind: "payment",
              merchant_refund: null,
            },
            {
              merchant_order: intent.merchant_order,
              provider_order: payment.providerOrder,
              amount_cents: 300,
              kind: "refund",
              merchant_refund: receipt.merchantRefund,
            },
          ],
        }),
      );
      assert.equal(reconciliation.matched_count, 2);
      assert.equal(reconciliation.mismatches.length, 0);
      const accountId = randomUUID();
      await transact((client) =>
        client.query(
          `INSERT INTO member_accounts(id,org_id,customer_id,opened_at,opened_store_id) VALUES($1,$2,$3,now(),$4)`,
          [accountId, tenant.orgId, customerId, tenant.storeId],
        ),
      );
      const topupInput = {
        ...input,
        idempotencyKey: randomUUID(),
        purpose: "topup" as const,
        orderId: null,
        accountId,
        customerId,
        amountCents: 1000,
      };
      const topup = await transact((client) => insertIntent(client, tenant, topupInput));
      await assert.rejects(
        transact((client) =>
          insertIntent(client, tenant, { ...topupInput, idempotencyKey: randomUUID() }),
        ),
        /RESOURCE_UNAVAILABLE/u,
      );
      assert.equal(
        (
          await transact((client) =>
            settleChannelPayment(client, tenant, local, topup.id, {
              ...payment,
              merchantOrder: topup.merchant_order,
              providerOrder: "provider_topup_1",
              amountCents: 1000,
            }),
          )
        ).state,
        "paid",
      );
      await assert.rejects(
        transact((client) =>
          createPgMemberStore(client, tenant).refund({
            account_id: accountId,
            store_id: tenant.storeId,
            amount_cents: 100,
            tender: "cash",
            reason: "manual",
            staff_id: tenant.staffId!,
            at: Math.floor(Date.now() / 1000),
            business_date: "2026-10-03",
            note: null,
          }),
        ),
        /CHANNEL_REFUND_REQUIRED/u,
      );
      const topupRefund = await queue(topup.id, 800);
      await assert.rejects(
        transact((client) =>
          client.query(
            `INSERT INTO member_ledger(id,org_id,account_id,store_id,kind,principal_delta_cents,bonus_delta_cents,tender,staff_id,at,business_date,order_id) VALUES($1,$2,$3,$4,'pay',-300,0,'balance',$5,now(),'2026-10-03',$6)`,
            [randomUUID(), tenant.orgId, accountId, tenant.storeId, tenant.staffId, orderId],
          ),
        ),
        /CHANNEL_REFUND_PENDING/u,
      );
      const secondStoreId = randomUUID();
      await admin.query(
        "INSERT INTO stores(id,org_id,code,name,timezone,created_at,updated_at) VALUES($1,$2,$3,'合成分店','Asia/Taipei',now(),now())",
        [secondStoreId, tenant.orgId, `s${secondStoreId.slice(0, 8)}`],
      );
      await assert.rejects(
        withClient(pool, (client) =>
          withTenantTransaction(client, { ...tenant, storeId: secondStoreId }, (tx) =>
            tx.query(
              `INSERT INTO member_ledger(id,org_id,account_id,store_id,kind,principal_delta_cents,bonus_delta_cents,tender,staff_id,at,business_date,order_id) VALUES($1,$2,$3,$4,'pay',-300,0,'balance',$5,now(),'2026-10-03',$6)`,
              [randomUUID(), tenant.orgId, accountId, secondStoreId, tenant.staffId, orderId],
            ),
          ),
        ),
        /CHANNEL_REFUND_PENDING/u,
      );
      const topupRefundRow = (
        await transact((client) =>
          client.query<{ merchant_refund: string }>(
            "SELECT merchant_refund FROM payment_channel_refunds WHERE id=$1",
            [topupRefund.refund_id],
          ),
        )
      ).rows[0]!;
      const topupReceipt = {
        merchantOrder: topup.merchant_order,
        merchantRefund: topupRefundRow.merchant_refund,
        providerRefund: "provider_topup_refund",
        amountCents: 800,
        state: "refunded" as const,
      };
      const topupSettled = await transact((client) =>
        settleChannelRefund(client, tenant, local, topupRefund.refund_id, topupReceipt),
      );
      assert.equal(topupSettled.state, "refunded");
      assert.notEqual(topupSettled.member_ledger_id, null);
      assert.equal(
        Number(
          (
            await admin.query<{ balance: string }>(
              "SELECT sum(principal_delta_cents) AS balance FROM member_ledger WHERE account_id=$1",
              [accountId],
            )
          ).rows[0]?.balance,
        ),
        200,
      );

      const blockedId = await newOrder();
      const blocked = await transact((client) =>
        insertIntent(client, tenant, {
          ...input,
          idempotencyKey: randomUUID(),
          orderId: blockedId,
        }),
      );
      const closedLocal = {
        ...local,
        order: { ...local.order, isBusinessDayClosed: async () => true },
      };
      const blockedPayment = {
        ...payment,
        merchantOrder: blocked.merchant_order,
        providerOrder: "provider_closed_day",
      };
      const pending = await transact((client) =>
        settleChannelPayment(client, tenant, closedLocal, blocked.id, blockedPayment),
      );
      assert.equal(pending.state, "needs_review");
      assert.equal(pending.payment_id, null);
      await assert.rejects(
        transact((client) =>
          insertIntent(client, tenant, {
            ...input,
            idempotencyKey: randomUUID(),
            orderId: blockedId,
          }),
        ),
        /RESOURCE_UNAVAILABLE/u,
      );
      await assert.rejects(
        transact((client) =>
          client.query("UPDATE orders SET status='cancelled' WHERE id=$1", [blockedId]),
        ),
        /CHANNEL_PAYMENT_PENDING/u,
      );
      assert.equal(
        (
          await transact((client) =>
            settleChannelPayment(client, tenant, local, blocked.id, blockedPayment),
          )
        ).state,
        "paid",
      );

      const unknownOrder = await newOrder();
      const unknownIntent = await transact((client) =>
        insertIntent(client, tenant, {
          ...input,
          idempotencyKey: randomUUID(),
          orderId: unknownOrder,
        }),
      );
      let sends = 0;
      const service = createChannelService(local, kms, async () => {
        sends++;
        throw new (await import("./types.js")).ChannelProtocolError("CHANNEL_TRANSPORT_FAILED");
      });
      assert.equal((await service.dispatch(tenant, unknownIntent.id)).state, "unknown");
      assert.equal((await service.dispatch(tenant, unknownIntent.id)).state, "unknown");
      assert.equal(sends, 1);
      assert.equal(
        (await service.read(tenant, unknownIntent.id)).error_code,
        "CHANNEL_TRANSPORT_FAILED",
      );
      await assert.rejects(service.read(other, unknownIntent.id), /RESOURCE_UNAVAILABLE/u);
      // Restore removes credential configuration; an unsubmitted intent can still
      // be safely closed without decrypting or contacting a provider.
      const unsubmittedOrder = await newOrder();
      const unsubmitted = await transact((client) =>
        insertIntent(client, tenant, {
          ...input,
          idempotencyKey: randomUUID(),
          orderId: unsubmittedOrder,
        }),
      );
      await transact((client) =>
        client.query(
          "UPDATE payment_channel_intents SET state='needs_review',error_code='MIGRATED_QUERY_REQUIRED' WHERE id=$1",
          [unsubmitted.id],
        ),
      );
      const withoutKms = createChannelService(local, null);
      assert.equal((await withoutKms.close(tenant, unsubmitted.id)).state, "closed");
      const replacement = await transact((client) =>
        insertIntent(client, tenant, {
          ...input,
          idempotencyKey: randomUUID(),
          orderId: unsubmittedOrder,
        }),
      );
      assert.notEqual(replacement.id, unsubmitted.id);
      const expiredOrder = await newOrder();
      const expiredId = randomUUID();
      await transact((client) =>
        client.query(
          `INSERT INTO payment_channel_intents(id,org_id,store_id,channel,purpose,order_id,customer_id,actor_id,idempotency_key,input_sha256,account_fingerprint,merchant_order,amount_cents,state,created_at,expires_at)
       SELECT $1::uuid,org_id,store_id,channel,purpose,$2::uuid,customer_id,actor_id,$3::uuid,input_sha256,account_fingerprint,$4,amount_cents,'needs_review',statement_timestamp()-interval '16 minutes',statement_timestamp()-interval '1 minute' FROM payment_channel_intents WHERE id=$5::uuid`,
          [expiredId, expiredOrder, randomUUID(), expiredId.replaceAll("-", ""), unknownIntent.id],
        ),
      );
      assert.equal((await withoutKms.sync(tenant, expiredId)).state, "closed");
      assert.ok(
        (
          await transact((client) =>
            client.query(
              "SELECT id FROM audit_log WHERE command='payment.channel.close_undispatched'",
            ),
          )
        ).rows.length >= 2,
      );
      const failedRefund = await queue(intent.id, 100);
      const failedRow = (
        await transact((client) =>
          client.query<{ merchant_refund: string }>(
            "SELECT merchant_refund FROM payment_channel_refunds WHERE id=$1",
            [failedRefund.refund_id],
          ),
        )
      ).rows[0]!;
      const failedReceipt = {
        ...receipt,
        merchantRefund: failedRow.merchant_refund,
        providerRefund: "failed_provider_refund",
        amountCents: 100,
        state: "failed" as const,
      };
      assert.equal(
        (
          await transact((client) =>
            settleChannelRefund(client, tenant, local, failedRefund.refund_id, failedReceipt),
          )
        ).state,
        "failed",
      );
      assert.equal(
        (
          await transact((client) =>
            settleChannelRefund(client, tenant, local, failedRefund.refund_id, failedReceipt),
          )
        ).state,
        "failed",
      );
      for (const unused of [1, 2, 3, 4]) {
        void unused;
        await transact(async (client) =>
          insertIntent(client, tenant, {
            ...input,
            idempotencyKey: randomUUID(),
            orderId: await newOrder(),
          }),
        );
      }
      const firstChecks = await transact((client) => claimChannelChecks(client, tenant));
      const secondChecks = await transact((client) => claimChannelChecks(client, tenant));
      assert.equal(firstChecks.intents.length, 3);
      assert.ok(
        new Set([...firstChecks.intents, ...secondChecks.intents].map((row) => row.id)).size > 3,
        "invalid oldest rows must not starve later receipts",
      );
    } finally {
      await pool.end();
      await admin.end();
    }
  },
);
