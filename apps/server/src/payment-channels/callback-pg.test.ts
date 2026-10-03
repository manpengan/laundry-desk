import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import { createPgPool, resolvePgUrls, withClient } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { createMemoryLocalRuntime } from "../local/demo-seed.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { encryptCredential } from "../ai/byok-envelope.js";
import type { ByokKmsPort } from "../ai/byok-kms.js";
import { serializeEnvelope } from "../notification/providers/credential-envelope.js";
import { registerRequestSecurityHooks } from "../http/request-security.js";
import { registerChannelCallbacks } from "./callback-routes.js";
import { accountFingerprint } from "./settings.js";
import { insertIntent } from "./intent-store.js";
import { channelFixture } from "./protocol-fixture.js";
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
  "raw signed callback crosses the real HTTP parser and app-role transaction exactly once",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin });
    const pool = createPgPool({ connectionString: urls.app });
    const fixture = channelFixture();
    const tenant = {
      orgId: LOCAL_PROFILE.orgId,
      storeId: LOCAL_PROFILE.storeId,
      staffId: LOCAL_PROFILE.adminStaffId,
    };
    const app = Fastify({ logger: false });
    try {
      await admin.query(
        `INSERT INTO orgs(id,code,name,created_at,updated_at) VALUES($1,'callback-fixture','Synthetic',now(),now())`,
        [tenant.orgId],
      );
      await admin.query(
        `INSERT INTO stores(id,org_id,code,name,timezone,created_at,updated_at) VALUES($1,$2,'callback-fixture','Synthetic','Asia/Taipei',now(),now())`,
        [tenant.storeId, tenant.orgId],
      );
      await admin.query(
        `INSERT INTO staffs(id,org_id,username,password_hash,display_name,created_at,updated_at) VALUES($1,$2,'callback-fixture','not-a-real-hash','Synthetic',now(),now())`,
        [tenant.staffId, tenant.orgId],
      );
      const base = await createMemoryLocalRuntime();
      const local = {
        ...base,
        mode: "pg" as const,
        pool,
        order: { ...base.order, isBusinessDayClosed: async () => false },
      };
      const transact = <T>(work: (client: import("../db/types.js").SqlClient) => Promise<T>) =>
        withClient(pool, (client) => withTenantTransaction(client, tenant, work));
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
          `INSERT INTO payment_channel_settings(org_id,store_id,channel,version,enabled,app_id,merchant_id,account_fingerprint,credential_id,envelope_json,updated_by) VALUES($1,$2,'wechat',1,true,$3,$4,$5,$6,$7,$8)`,
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
      const orderId = randomUUID();
      await transact((client) =>
        client.query(
          `INSERT INTO orders(id,org_id,store_id,ticket_no,pickup_code,status,subtotal_cents,original_cents,payable_cents,paid_cents,balance_cents,created_at,updated_at,created_by_staff_id,business_date) VALUES($1::uuid,$2,$3,$1::text,'654321','open',1200,1200,1200,0,1200,now(),now(),$4,'2026-10-03')`,
          [orderId, tenant.orgId, tenant.storeId, tenant.staffId],
        ),
      );
      const intent = await transact((client) =>
        insertIntent(client, tenant, {
          idempotencyKey: randomUUID(),
          channel: "wechat",
          purpose: "order",
          orderId,
          accountId: null,
          customerId: null,
        }),
      );
      registerRequestSecurityHooks(app, {
        allowedHosts: ["127.0.0.1:8787"],
        browserOrigin: "http://127.0.0.1:5173",
        browserFetchSite: "same-site",
        desktopOrigin: "http://127.0.0.1:8787",
      });
      registerChannelCallbacks(app, local, kms);
      await app.ready();
      const notice = (amount: number) => {
        const value = {
          appid: fixture.wechat.appId,
          mchid: fixture.wechat.merchantId,
          out_trade_no: intent.merchant_order,
          transaction_id: "callback_transaction",
          trade_state: "SUCCESS",
          amount: { total: amount, currency: "CNY" },
          success_time: new Date().toISOString(),
        };
        const cipher = createCipheriv(
          "aes-256-gcm",
          Buffer.from(fixture.wechat.apiV3Key),
          Buffer.from("123456789012"),
        );
        cipher.setAAD(Buffer.from("transaction"));
        const bytes = Buffer.concat([
          cipher.update(JSON.stringify(value)),
          cipher.final(),
          cipher.getAuthTag(),
        ]);
        const raw = JSON.stringify(
          {
            id: "callback_receipt",
            event_type: "TRANSACTION.SUCCESS",
            resource_type: "encrypt-resource",
            resource: {
              algorithm: "AEAD_AES_256_GCM",
              nonce: "123456789012",
              associated_data: "transaction",
              ciphertext: bytes.toString("base64"),
            },
          },
          null,
          2,
        );
        const timestamp = String(Math.floor(Date.now() / 1000));
        const nonce = "callback_nonce";
        const signature = sign(
          "RSA-SHA256",
          Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`),
          fixture.platform.privateKey,
        ).toString("base64");
        return {
          raw,
          headers: {
            host: "127.0.0.1:8787",
            "content-type": "application/json",
            "wechatpay-serial": fixture.wechat.platformKeyId,
            "wechatpay-timestamp": timestamp,
            "wechatpay-nonce": nonce,
            "wechatpay-signature": signature,
          },
        };
      };
      const wrong = notice(1201);
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/v2/payment-channels/callback/wechat",
            headers: wrong.headers,
            payload: wrong.raw,
          })
        ).statusCode,
        400,
      );
      const valid = notice(1200);
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/v2/payment-channels/callback/wechat",
            headers: valid.headers,
            payload: `${valid.raw} `,
          })
        ).statusCode,
        400,
      );
      for (const unused of [1, 2]) {
        void unused;
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/api/v2/payment-channels/callback/wechat",
              headers: valid.headers,
              payload: valid.raw,
            })
          ).statusCode,
          204,
        );
      }
      const count = await admin.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM payments WHERE order_id=$1",
        [orderId],
      );
      assert.equal(count.rows[0]?.count, 1);
    } finally {
      await app.close();
      await pool.end();
      await admin.end();
    }
  },
);
