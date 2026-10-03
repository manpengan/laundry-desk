import assert from "node:assert/strict";
import { test } from "node:test";
import { createPgPool, resolvePgUrls } from "../../db/pg-pool.js";
import {
  seedNotificationTenant,
  seedNotificationCandidate,
  enqueueNotificationBatch,
} from "../pg-delivery-test-fixture.js";
import { createPgNotificationDeliveryStore } from "../pg-delivery-store.js";
import { runNotificationWorkerOnce } from "../delivery-worker.js";
import { createAliyunSmsClient } from "./aliyun-client.js";
import { createAliyunNotificationProvider, aliyunCapability } from "./aliyun-provider.js";
import { reconcileAliyunReceipts } from "./aliyun-receipts.js";
import { settingsFixture } from "./settings-test-fixture.js";

const urls = resolvePgUrls(process.env);
test(
  "real PG Aliyun outbox settles exact receipts and retains unknown outcomes without resend",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin });
    const app = createPgPool({ connectionString: urls.app });
    const fixture = await seedNotificationTenant(admin);
    const store = createPgNotificationDeliveryStore(app);
    const settings = {
      version: 1,
      provider: "aliyun_sms" as const,
      enabled: true,
      sign_name: "测试洗衣",
      template_code: "SMS_123",
      unit_cost_cents: 5,
      max_batch_cost_cents: 250,
    };
    let sends = 0;
    let ambiguous = false;
    let sentId = "";
    let sentPhone = "";
    const client = createAliyunSmsClient({
      credentials: async () => ({
        accessKeyId: "SyntheticId123",
        accessKeySecret: "SyntheticSecret123",
      }),
      fetch: async (url, request) => {
        if (request.headers["x-acs-action"] === "SendSms") {
          sends++;
          sentId = new URL(url).searchParams.get("OutId") ?? "";
          sentPhone = new URL(url).searchParams.get("PhoneNumbers") ?? "";
          if (ambiguous) throw new Error("synthetic network interruption");
          return Response.json({ Code: "OK", BizId: "synthetic-biz" });
        }
        return Response.json({
          Code: "OK",
          TotalCount: 1,
          SmsSendDetailDTOs: {
            SmsSendDetailDTO: [
              {
                OutId: sentId,
                PhoneNum: sentPhone,
                TemplateCode: settings.template_code,
                SendStatus: 3,
              },
            ],
          },
        });
      },
    });
    const provider = createAliyunNotificationProvider(settings, client, async () => true);
    const configured = await settingsFixture(admin, app, fixture.tenant);
    const fields = {
      provider: settings.provider,
      enabled: settings.enabled,
      sign_name: settings.sign_name,
      template_code: settings.template_code,
      unit_cost_cents: settings.unit_cost_cents,
      max_batch_cost_cents: settings.max_batch_cost_cents,
    };
    const configInput = {
      ...fields,
      expected_version: 0,
      password: configured.password,
      credential: { accessKeyId: "SyntheticId123", accessKeySecret: "SyntheticSecret123" },
    };
    await configured.service.save(configured.auth, configInput);
    const enqueue = async (index: number) => {
      const candidate = await seedNotificationCandidate(app, fixture, index, new Date());
      const batch = await enqueueNotificationBatch(
        app,
        fixture,
        candidate.orderId,
        new Date(),
        store,
        aliyunCapability(settings),
      );
      await admin.query(
        "UPDATE notification_deliveries SET next_attempt_at=statement_timestamp()-interval '1 millisecond' WHERE batch_id=$1",
        [batch.batch_id],
      );
      return batch;
    };
    try {
      const batch = await enqueue(1);
      const accepted = await runNotificationWorkerOnce({
        store,
        provider,
        tenant: fixture.tenant,
        workerId: "aliyun-test",
      });
      assert.equal(accepted.kind, "accepted");
      await reconcileAliyunReceipts({
        pool: app,
        tenant: fixture.tenant,
        store,
        client,
        templateCode: settings.template_code,
      });
      const delivered = await admin.query<{ status: string; cost_cents: number }>(
        "SELECT status,cost_cents FROM notification_deliveries WHERE batch_id=$1",
        [batch.batch_id],
      );
      assert.equal(delivered.rows[0]?.status, "delivered");
      assert.equal(delivered.rows[0]?.cost_cents, 5);
      ambiguous = true;
      const unknown = await enqueue(2);
      assert.equal(
        (
          await runNotificationWorkerOnce({
            store,
            provider,
            tenant: fixture.tenant,
            workerId: "aliyun-test",
          })
        ).kind,
        "manual_required",
      );
      const evidence = await admin.query<{ status: string; reserved_cost_cents: number }>(
        "SELECT status,reserved_cost_cents FROM notification_deliveries WHERE batch_id=$1",
        [unknown.batch_id],
      );
      assert.equal(evidence.rows[0]?.status, "manual_required");
      assert.equal(evidence.rows[0]?.reserved_cost_cents, 5);
      assert.equal(
        (
          await runNotificationWorkerOnce({
            store,
            provider,
            tenant: fixture.tenant,
            workerId: "aliyun-test",
          })
        ).kind,
        "idle",
      );
      assert.equal(sends, 2);
      await assert.rejects(
        configured.service.save(configured.auth, {
          ...configInput,
          expected_version: 1,
          template_code: "SMS_456",
        }),
        /RESOURCE_UNAVAILABLE/u,
      );
      const rotated = await configured.service.save(configured.auth, {
        ...configInput,
        expected_version: 1,
        credential: {
          accessKeyId: "RotatedSyntheticId",
          accessKeySecret: "RotatedSyntheticSecret",
        },
      });
      assert.equal(rotated.settings?.version, 2);
      const retained = await admin.query<{ status: string; reserved_cost_cents: number }>(
        "SELECT status,reserved_cost_cents FROM notification_deliveries WHERE batch_id=$1",
        [unknown.batch_id],
      );
      assert.deepEqual(retained.rows, evidence.rows);
      assert.equal(sends, 2);
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  },
);
