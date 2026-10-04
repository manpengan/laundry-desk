import { createIsolatedPgTestDatabase } from "../db/isolated-pg-test-database.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  WechatNotificationRecordSchema,
  wechatNotificationConfigure,
  wechatNotificationSend,
} from "@laundry/contracts";
import { createPgPool, resolvePgUrls, withClient } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { createMemoryLocalRuntime } from "../local/demo-seed.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { TestByokKms } from "../ai/byok-test-kms.js";
import { encryptCredential } from "../ai/byok-envelope.js";
import { serializeEnvelope } from "../notification/providers/credential-envelope.js";
import { writeAuditForOutcome } from "../bus/audit-outcome.js";
import type { SqlClient } from "../db/types.js";
import { notificationWechatHandlers } from "./notifications-handlers.js";
import { previewNotification } from "./notifications-store.js";
import { createWechatNotificationDispatcher } from "./notifications-dispatch.js";
const urls = resolvePgUrls();
test(
  "real PG WeChat notifications consume one consent atomically, dispatch once and never replay ambiguous or restored rows",
  { skip: urls === null },
  async (t) => {
    assert.ok(urls);
    const database = await createIsolatedPgTestDatabase(urls);
    t.after(database.close);
    const admin = createPgPool({ connectionString: database.urls.admin }),
      pool = createPgPool({ connectionString: database.urls.app });
    const tenant = {
      orgId: LOCAL_PROFILE.orgId,
      storeId: LOCAL_PROFILE.storeId,
      staffId: LOCAL_PROFILE.adminStaffId,
    };
    const kms = new TestByokKms("windows-dpapi-current-user", "1");
    const customer = randomUUID(),
      binding = randomUUID(),
      session = randomUUID(),
      credentialId = randomUUID();
    const appId = "wx1234567890abcdef",
      openid = "synthetic_openid_1234";
    const transact = <T>(work: (client: SqlClient) => Promise<T>) =>
      withClient(pool, (c) => withTenantTransaction(c, tenant, work));
    const handlers = notificationWechatHandlers(true);
    const actor = {
      staffId: tenant.staffId,
      deviceId: null,
      via: "ui" as const,
      permissions: ["store_manage", "customer_read", "notification_send"],
    };
    const call = async (
      name: "notification.wechat.settings.set" | "notification.wechat.send",
      input: unknown,
      fail = false,
    ) =>
      transact(async (client) => {
        const definition = name.endsWith("send")
          ? wechatNotificationSend
          : wechatNotificationConfigure;
        const context = {
          tenant,
          actor,
          client,
          definition,
          parsed: input,
          request: { name, version: "1.0.0", input, dryRun: false, idempotencyKey: randomUUID() },
        };
        const outcome = await handlers[name](context);
        if (fail) throw new Error("synthetic audit failure");
        await writeAuditForOutcome(client, context, outcome.audit, {});
        return outcome.result;
      });
    try {
      await admin.query(
        `INSERT INTO orgs(id,code,name,created_at,updated_at) VALUES($1,'wechat-notification','Synthetic',now(),now())`,
        [tenant.orgId],
      );
      await admin.query(
        `INSERT INTO stores(id,org_id,code,name,timezone,created_at,updated_at) VALUES($1,$2,'wechat-notification','虚构门店','Asia/Taipei',now(),now())`,
        [tenant.storeId, tenant.orgId],
      );
      await admin.query(
        `INSERT INTO staffs(id,org_id,username,password_hash,display_name,created_at,updated_at) VALUES($1,$2,'wechat-notification','not-real','Synthetic',now(),now())`,
        [tenant.staffId, tenant.orgId],
      );
      await admin.query(
        `INSERT INTO staff_store_roles(id,org_id,store_id,staff_id,role,is_privacy_admin,created_at,updated_at) VALUES($1,$2,$3,$4,'admin',true,now(),now())`,
        [randomUUID(), tenant.orgId, tenant.storeId, tenant.staffId],
      );
      await admin.query(
        `INSERT INTO customers(id,org_id,phone,name,created_at,updated_at) VALUES($1,$2,'13800000901','虚构顾客',now(),now())`,
        [customer, tenant.orgId],
      );
      const envelope = serializeEnvelope(
        await encryptCredential(
          kms,
          { orgId: tenant.orgId, providerCode: "miniapp_wechat", credentialId },
          Buffer.from("synthetic-miniapp-secret"),
        ),
      );
      const recipient = serializeEnvelope(
        await encryptCredential(
          kms,
          { orgId: tenant.orgId, providerCode: "miniapp_recipient", credentialId: binding },
          Buffer.from(openid),
        ),
      );
      await transact((client) =>
        client.query(
          `INSERT INTO miniapp_settings(org_id,store_id,version,enabled,app_id,credential_id,envelope_json,subscription_template_ids,updated_by) VALUES($1,$2,1,true,$3,$4,$5,'["approved_template"]',$6)`,
          [tenant.orgId, tenant.storeId, appId, credentialId, envelope, tenant.staffId],
        ),
      );
      await transact((client) =>
        client.query(
          `INSERT INTO miniapp_bindings(id,org_id,store_id,app_id,openid_sha256,encrypted_openid_json,customer_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [binding, tenant.orgId, tenant.storeId, appId, "a".repeat(64), recipient, customer],
        ),
      );
      await transact((client) =>
        client.query(
          `INSERT INTO miniapp_sessions(id,org_id,store_id,binding_id,customer_id,config_version,expires_at) VALUES($1,$2,$3,$4,$5,1,statement_timestamp()+interval '10 minutes')`,
          [session, tenant.orgId, tenant.storeId, binding, customer],
        ),
      );
      const consent = () =>
        transact((client) =>
          client.query(
            `INSERT INTO miniapp_subscriptions(id,org_id,store_id,customer_id,session_id,template_id) VALUES($1,$2,$3,$4,$5,'approved_template') RETURNING id`,
            [randomUUID(), tenant.orgId, tenant.storeId, customer, session],
          ),
        );
      const order = async (index: number) => {
        const id = randomUUID(),
          line = randomUUID();
        await transact(async (client) => {
          await client.query(
            `INSERT INTO orders(id,org_id,store_id,customer_id,ticket_no,pickup_code,status,subtotal_cents,original_cents,payable_cents,paid_cents,balance_cents,created_at,updated_at,created_by_staff_id,business_date) VALUES($1,$2,$3,$4,$5,$7,'open',1000,1000,1000,0,1000,now(),now(),$6,'2026-10-03')`,
            [
              id,
              tenant.orgId,
              tenant.storeId,
              customer,
              `20261003-${index}`,
              tenant.staffId,
              String(654320 + index),
            ],
          );
          await client.query(
            `INSERT INTO order_lines(id,org_id,store_id,order_id,line_index,service_code,category_code,unit_price_cents,qty,line_total_cents) VALUES($1,$2,$3,$4,0,'wash','shirt',1000,1,1000)`,
            [line, tenant.orgId, tenant.storeId, id],
          );
          await client.query(
            `INSERT INTO garments(id,org_id,store_id,order_id,order_line_id,seq,barcode,service_code,category_code,unit_price_cents,status) VALUES($1,$2,$3,$4,$5,1,$6,'wash','shirt',1000,'ready')`,
            [randomUUID(), tenant.orgId, tenant.storeId, id, line, `synthetic-${index}`],
          );
        });
        return id;
      };
      const config = {
        expected_version: 0,
        enabled: true,
        template_id: "approved_template",
        ticket_field: "character_string1",
        store_field: "thing2",
        status_field: "phrase3",
        miniprogram_state: "trial",
      };
      const first = await order(1);
      await consent();
      await assert.rejects(
        transact((client) => previewNotification(client, tenant, first)),
        /RESOURCE_UNAVAILABLE/u,
      );
      await call("notification.wechat.settings.set", config);
      const getPreview = (id: string) =>
        transact((client) => previewNotification(client, tenant, id));
      const preview = await getPreview(first);
      assert.equal(preview.view.payload.ticket, "20261003-1");
      const send = { order_id: first, preview_sha256: preview.view.preview_sha256 };
      await assert.rejects(
        call("notification.wechat.send", send, true),
        /synthetic audit failure/u,
      );
      assert.equal(
        (await admin.query(`SELECT count(*)::int n FROM miniapp_notification_outbox`)).rows[0].n,
        0,
      );
      assert.equal((await getPreview(first)).view.consent_id, preview.view.consent_id);
      const both = await Promise.allSettled([
        call("notification.wechat.send", send),
        call("notification.wechat.send", send),
      ]);
      assert.equal(both.filter((x) => x.status === "fulfilled").length, 1);
      const row = both.find((x) => x.status === "fulfilled");
      assert.ok(row?.status === "fulfilled");
      const queued = WechatNotificationRecordSchema.parse(row.value);
      await assert.rejects(
        transact((client) =>
          client.query(
            `UPDATE miniapp_subscriptions SET consumed_at=NULL,outbox_id=NULL WHERE id=$1`,
            [preview.view.consent_id],
          ),
        ),
        /SUBSCRIPTION_CONSUMPTION_TERMINAL/u,
      );
      let sends = 0,
        tokens = 0;
      const local = { ...(await createMemoryLocalRuntime()), mode: "pg" as const, pool };
      const dispatcher = createWechatNotificationDispatcher(local, kms, {
        token: async () => {
          tokens++;
          return "synthetic-token";
        },
        send: async (_token, recipient, configuration, payload) => {
          sends++;
          assert.equal(recipient, openid);
          assert.equal(configuration.template_id, "approved_template");
          assert.deepEqual(payload, preview.view.payload);
          return { state: "unknown", errorCode: "WECHAT_SEND_UNKNOWN" };
        },
      });
      await Promise.all([
        dispatcher.advance(tenant, queued.id),
        dispatcher.advance(tenant, queued.id),
      ]);
      await dispatcher.advance(tenant, queued.id);
      assert.equal(sends, 1);
      assert.ok(tokens >= 1);
      assert.equal(
        (
          await admin.query(`SELECT state FROM miniapp_notification_outbox WHERE id=$1`, [
            queued.id,
          ])
        ).rows[0].state,
        "unknown",
      );
      await assert.rejects(
        transact((client) =>
          client.query(`UPDATE miniapp_notification_outbox SET state='queued' WHERE id=$1`, [
            queued.id,
          ]),
        ),
        /NOTIFICATION_DISPATCH_TERMINAL/u,
      );
      await assert.rejects(
        transact((client) =>
          client.query(`UPDATE miniapp_notification_outbox SET dispatched_at=NULL WHERE id=$1`, [
            queued.id,
          ]),
        ),
        /NOTIFICATION_DISPATCH_TERMINAL/u,
      );
      const spare = (await consent()).rows[0] as { id: string };
      await assert.rejects(
        transact((client) =>
          client.query(
            `INSERT INTO miniapp_notification_outbox(id,org_id,store_id,order_id,customer_id,binding_id,consent_id,created_by,settings_version,miniapp_version,template_id,payload_json,preview_sha256,state) SELECT $2::uuid,org_id,store_id,order_id,customer_id,binding_id,$3::uuid,created_by,settings_version,miniapp_version,'different_template',payload_json,preview_sha256,'queued' FROM miniapp_notification_outbox WHERE id=$1::uuid`,
            [queued.id, randomUUID(), spare.id],
          ),
        ),
        /miniapp_notification_once_idx/u,
      );
      const audit = (
        await admin.query(
          `SELECT after_json FROM audit_log WHERE command LIKE 'notification.wechat.%'`,
        )
      ).rows
        .map((r) => r.after_json)
        .join("");
      assert.doesNotMatch(audit, /synthetic_openid|synthetic-token|miniapp-secret|虚构顾客/u);
      assert.match(audit, /WECHAT_SEND_UNKNOWN/u);
      const next = await order(2);
      await consent();
      const p2 = await getPreview(next);
      const queued2 = WechatNotificationRecordSchema.parse(
        await call("notification.wechat.send", {
          order_id: next,
          preview_sha256: p2.view.preview_sha256,
        }),
      );
      await admin.query(`UPDATE garments SET status='washing' WHERE order_id=$1`, [next]);
      await dispatcher.advance(tenant, queued2.id);
      assert.equal(sends, 1);
      assert.equal(
        (
          await admin.query(`SELECT state FROM miniapp_notification_outbox WHERE id=$1`, [
            queued2.id,
          ])
        ).rows[0].state,
        "cancelled",
      );
      const third = await order(3);
      await consent();
      const p3 = await getPreview(third);
      const queued3 = WechatNotificationRecordSchema.parse(
        await call("notification.wechat.send", {
          order_id: third,
          preview_sha256: p3.view.preview_sha256,
        }),
      );
      await admin.query(
        `UPDATE miniapp_notification_outbox SET state='needs_review',error_code='RESTORED_NO_REDISPATCH' WHERE id=$1`,
        [queued3.id],
      );
      await dispatcher.advance(tenant, queued3.id);
      assert.equal(sends, 1);
      await assert.rejects(
        transact((client) =>
          client.query(`UPDATE miniapp_notification_outbox SET state='queued' WHERE id=$1`, [
            queued3.id,
          ]),
        ),
        /NOTIFICATION_DISPATCH_TERMINAL/u,
      );
      await assert.rejects(
        transact((client) =>
          previewNotification(client, { ...tenant, storeId: randomUUID() }, first),
        ),
        /PERMISSION_DENIED/u,
      );
    } finally {
      await pool.end();
      await admin.end();
    }
  },
);
