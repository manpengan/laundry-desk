import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PgPool } from "../db/pg-pool.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import type { ByokKmsPort } from "../ai/byok-kms.js";
import { encryptCredential } from "../ai/byok-envelope.js";
import { serializeEnvelope } from "../notification/providers/credential-envelope.js";
import { createPgMemberBenefitsStore } from "../member-benefits/pg-store.js";
import { channelFixture } from "../payment-channels/protocol-fixture.js";
import { createChannelService } from "../payment-channels/service.js";
import { ChannelProtocolError } from "../payment-channels/types.js";
import { accountFingerprint } from "../payment-channels/settings.js";
import { createMiniappService } from "./service.js";
import type { MiniappIdentityService } from "./identity.js";
import { delegation } from "./authority.js";
import { MINIAPP_TENANT } from "./types.js";
type Fixture = Readonly<{
  admin: PgPool;
  local: LocalRuntime;
  kms: ByokKmsPort;
  identity: MiniappIdentityService;
  service: ReturnType<typeof createMiniappService>;
  token: string;
  otherToken: string;
  customerId: string;
  otherId: string;
  accountId: string;
  order: (owner?: string, amount?: number) => Promise<string>;
}>;
export async function exerciseAppointments(f: Fixture) {
  const { orgId, storeId } = MINIAPP_TENANT;
  const staffId = f.local.staffDirectory[0]!.staff_id;
  await f.admin.query("UPDATE store_features SET delivery=true WHERE store_id=$1", [storeId]);
  await f.admin.query(
    `INSERT INTO delivery_policies(org_id,store_id,accepting_appointments,minimum_lead_minutes,maximum_advance_days,slot_minutes,max_appointments_per_slot,
    service_areas_json,weekly_windows_json,version,updated_at,updated_by_staff_id) VALUES($1,$2,true,0,14,60,10,$3,$4,1,now(),$5)`,
    [
      orgId,
      storeId,
      JSON.stringify([{ code: "all", name: "合成区域", fee_cents: 100, is_active: true }]),
      JSON.stringify(
        Array.from({ length: 7 }, (_, i) => ({
          weekday: i + 1,
          start_minute: 0,
          end_minute: 1440,
        })),
      ),
      staffId,
    ],
  );
  const address = (
    await f.admin.query<{ id: string }>(
      "SELECT id::text FROM customer_addresses WHERE customer_id=$1 AND portal_managed AND retired_at IS NULL",
      [f.customerId],
    )
  ).rows[0];
  assert.ok(address);
  const body = {
    idempotency_key: randomUUID(),
    address_id: address.id,
    direction: "pickup",
    service_area_code: "all",
    requested_start_at: Math.ceil(Date.now() / 3600000) * 3600 + 7200,
    expected_policy_version: 1,
  };
  const result = z
    .object({ appointment: z.object({ appointment_id: z.uuid(), version: z.number() }) })
    .parse(await f.service.transaction(f.token, "appointments/create", body));
  assert.deepEqual(
    await f.service.transaction(f.token, "appointments/create", body),
    await f.service.transaction(f.token, "appointments/create", body),
  );
  await assert.rejects(
    f.service.transaction(f.otherToken, "appointments/create", {
      ...body,
      idempotency_key: randomUUID(),
    }),
  );
  const cancel = {
    idempotency_key: randomUUID(),
    appointment_id: result.appointment.appointment_id,
    expected_version: result.appointment.version,
  };
  await assert.rejects(
    f.service.transaction(f.otherToken, "appointments/cancel", cancel),
    /RESOURCE_UNAVAILABLE/u,
  );
  const cancelled = z
    .object({ appointment: z.object({ status: z.literal("cancelled") }) })
    .parse(await f.service.transaction(f.token, "appointments/cancel", cancel));
  assert.equal(cancelled.appointment.status, "cancelled");
  assert.equal(
    (
      await f.admin.query(
        `SELECT count(*)::int n FROM miniapp_transaction_receipts WHERE action LIKE 'appointments/%'`,
      )
    ).rows[0].n,
    2,
  );
}
export async function exerciseBenefits(f: Fixture) {
  const at = Math.floor(Date.now() / 1000),
    day = new Date().toISOString().slice(0, 10);
  const orderId = await f.order(f.customerId, 3000);
  const foreignOrder = await f.order(f.otherId, 3000);
  const granted = await f.identity.transact(f.token, async (tx) => {
    const authority = await delegation(tx),
      store = createPgMemberBenefitsStore(tx.client, authority.tenant);
    const evidence = {
      store_id: tx.tenant.storeId,
      staff_id: authority.actor.staffId,
      at,
      business_date: day,
    };
    const punch = await store.upsertDefinition({
      definition: {
        kind: "punch_type",
        expected_version: 0,
        code: "miniapp10",
        name: "合成次卡",
        total_uses: 10,
        valid_days: 30,
        status: "active",
      },
      staff_id: evidence.staff_id,
      at,
    });
    assert.ok(punch.ok);
    const coupon = await store.upsertDefinition({
      definition: {
        kind: "coupon_type",
        expected_version: 0,
        code: "miniapp_coupon",
        name: "合成券",
        discount_cents: 100,
        min_order_cents: 1000,
        valid_days: 30,
        status: "active",
      },
      staff_id: evidence.staff_id,
      at,
    });
    assert.ok(coupon.ok);
    assert.ok(
      "definition_id" in punch.value.definition && "definition_id" in coupon.value.definition,
    );
    const p = await store.grantAsset({
      ...evidence,
      asset_kind: "punch",
      account_id: f.accountId,
      definition_id: punch.value.definition.definition_id,
      reason: "合成发放",
    });
    assert.ok(p.ok);
    const c = await store.grantAsset({
      ...evidence,
      asset_kind: "coupon",
      account_id: f.accountId,
      definition_id: coupon.value.definition.definition_id,
      reason: "合成发放",
    });
    assert.ok(c.ok);
    const policy = await store.upsertDefinition({
      definition: {
        kind: "points_policy",
        expected_version: 0,
        unit_cents: 100,
        points_per_unit: 1,
        valid_days: 30,
        status: "active",
      },
      staff_id: evidence.staff_id,
      at,
    });
    assert.ok(policy.ok);
    const earnOrder = await f.order(f.customerId, 3000);
    await f.admin.query(
      `UPDATE orders SET paid_cents=payable_cents,balance_cents=0,status='closed' WHERE id=$1`,
      [earnOrder],
    );
    const earned = await store.earnPoints({
      ...evidence,
      account_id: f.accountId,
      order_id: earnOrder,
    });
    assert.ok(earned.ok);
    const punchId = p.value.benefits.punch_cards[0]?.asset_id,
      couponId = c.value.benefits.coupons[0]?.asset_id;
    assert.ok(punchId && couponId);
    return { punchId, couponId };
  });
  for (const [action, extra] of [
    ["benefits/coupon", { asset_id: granted.couponId }],
    ["benefits/punch", { asset_id: granted.punchId, uses: 2 }],
    ["benefits/points", { points: 5 }],
  ] as const) {
    const body = { idempotency_key: randomUUID(), order_id: orderId, ...extra };
    await assert.rejects(
      f.service.transaction(f.otherToken, action, body),
      /RESOURCE_UNAVAILABLE/u,
    );
    await assert.rejects(
      f.service.transaction(f.token, action, { ...body, order_id: foreignOrder }),
      /RESOURCE_UNAVAILABLE/u,
    );
    const result = await f.service.transaction(f.token, action, body);
    assert.deepEqual(await f.service.transaction(f.token, action, body), result);
  }
  assert.equal(
    (await f.admin.query("SELECT discount_cents FROM orders WHERE id=$1", [orderId])).rows[0]
      .discount_cents,
    100,
  );
  assert.equal(
    (
      await f.admin.query(
        `SELECT count(*)::int n FROM miniapp_transaction_receipts WHERE action LIKE 'benefits/%'`,
      )
    ).rows[0].n,
    3,
  );
}
export async function exercisePaymentIntents(f: Fixture) {
  const fixture = channelFixture(),
    credential = { ...fixture.wechat, appId: "wx0123456789abcdef" };
  const credentialId = randomUUID();
  const envelope = serializeEnvelope(
    await encryptCredential(
      f.kms,
      { orgId: MINIAPP_TENANT.orgId, providerCode: "payment_wechat", credentialId },
      Buffer.from(JSON.stringify(credential)),
    ),
  );
  await f.admin.query(
    `INSERT INTO payment_channel_settings(org_id,store_id,channel,version,enabled,app_id,merchant_id,account_fingerprint,credential_id,envelope_json,updated_by)
    VALUES($1,$2,'wechat',1,true,$3,$4,$5,$6,$7,$8)`,
    [
      MINIAPP_TENANT.orgId,
      MINIAPP_TENANT.storeId,
      credential.appId,
      credential.merchantId,
      accountFingerprint(credential),
      credentialId,
      envelope,
      f.local.staffDirectory[0]!.staff_id,
    ],
  );
  let calls = 0;
  const channel = createChannelService(f.local, f.kms, async () => {
    calls++;
    throw new ChannelProtocolError("CHANNEL_TRANSPORT_FAILED");
  });
  const service = createMiniappService(f.local, f.kms, f.identity, channel);
  const orderId = await f.order();
  const foreign = await f.order(f.otherId);
  await assert.rejects(
    service.transaction(f.token, "payment/create", {
      idempotency_key: randomUUID(),
      order_id: foreign,
    }),
    /RESOURCE_UNAVAILABLE/u,
  );
  const body = { idempotency_key: randomUUID(), order_id: orderId };
  const result = z
    .object({ intent_id: z.uuid(), state: z.literal("unknown"), checkout: z.null() })
    .parse(await service.transaction(f.token, "payment/create", body));
  await service.transaction(f.token, "payment/create", body);
  assert.equal(calls, 1);
  await assert.rejects(
    service.transaction(f.otherToken, "payment/status", { intent_id: result.intent_id }),
    /RESOURCE_UNAVAILABLE/u,
  );
  await assert.rejects(
    service.transaction(f.token, "balance/pay", {
      idempotency_key: randomUUID(),
      order_id: orderId,
    }),
    /INVARIANT_FAILED/u,
  );
  const canonicalCustomer = randomUUID();
  await f.admin.query(
    `INSERT INTO customers(id,org_id,phone,name,created_at,updated_at) VALUES($1,$2,'13800000003','合成合并主档',now(),now())`,
    [canonicalCustomer, MINIAPP_TENANT.orgId],
  );
  const mergeClient = await f.admin.connect();
  try {
    await mergeClient.query("BEGIN");
    await mergeClient.query("SELECT set_config('app.org_id',$1,true)", [MINIAPP_TENANT.orgId]);
    await mergeClient.query("UPDATE customers SET merged_into_id=$2,merged_at=now() WHERE id=$1", [
      f.customerId,
      canonicalCustomer,
    ]);
    await mergeClient.query("COMMIT");
  } finally {
    await mergeClient.query("ROLLBACK");
    mergeClient.release();
  }
  const topup = z.object({ intent_id: z.uuid(), state: z.literal("unknown") }).parse(
    await service.transaction(f.token, "topup/create", {
      idempotency_key: randomUUID(),
      amount_cents: 1000,
    }),
  );
  assert.notEqual(topup.intent_id, result.intent_id);
  assert.deepEqual(
    (
      await f.admin.query(
        "SELECT customer_id::text,account_id::text FROM payment_channel_intents WHERE id=$1",
        [topup.intent_id],
      )
    ).rows[0],
    { customer_id: f.customerId, account_id: f.accountId },
  );
  assert.equal(
    (
      await f.admin.query(
        "SELECT customer_id::text FROM miniapp_transaction_receipts WHERE action='topup/create'",
      )
    ).rows[0].customer_id,
    canonicalCustomer,
  );
  await assert.rejects(
    service.transaction(f.token, "topup/create", {
      idempotency_key: randomUUID(),
      amount_cents: 1000,
    }),
  );
  const receipts = await f.admin.query(
    `SELECT result_json FROM miniapp_transaction_receipts WHERE action IN('payment/create','topup/create')`,
  );
  assert.equal(receipts.rows.length, 2);
  assert.doesNotMatch(JSON.stringify(receipts.rows), /paySign|prepay|openid|PRIVATE/u);
  assert.equal(
    (await f.admin.query("SELECT paid_cents FROM orders WHERE id=$1", [orderId])).rows[0]
      .paid_cents,
    0,
  );
}
