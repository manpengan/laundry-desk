import { randomUUID } from "node:crypto";
import type { PgPool } from "../db/pg-pool.js";
import type { V1Snapshot } from "@laundry/migrate-v1/plan";

/** Synthetic data only; imported exclusively by data-transfer tests. */
export function migrationFixture(): V1Snapshot {
  return {
    history: {
      staffs: [
        {
          id: 7,
          username: "old-admin",
          display_name: "虚构旧员工",
          role: "admin",
          is_active: 1,
          created_at: null,
          last_login_at: null,
        },
      ],
      sms: [
        {
          id: 1,
          order_id: 1,
          phone: "13800000111",
          content: "虚构顾客取衣通知",
          status: "sent",
          provider_response: null,
          sent_at: null,
        },
        {
          id: 2,
          order_id: null,
          phone: "13800000999",
          content: "未知归属虚构短信",
          status: "failed",
          provider_response: "虚构响应",
          sent_at: null,
        },
      ],
      audit: [
        {
          id: 1,
          staff_id: 7,
          action: "update",
          entity: "order",
          entity_id: 1,
          diff: '{"name":"虚构顾客"}',
          created_at: null,
        },
      ],
      excluded_credential_count: 1,
    },
    sourceBackupSha256: "a".repeat(64),
    customers: [
      {
        id: 1,
        name: "虚构顾客",
        phone: "13800000111",
        vipLevel: 1,
        totalOrders: 1,
        totalSpentCents: 3000,
        createdAt: 1720000000,
        updatedAt: null,
      },
    ],
    orders: [
      {
        id: 1,
        orderNo: "20240703-0001",
        pickupCode: "1357",
        customerId: 1,
        status: "picked_up",
        totalCents: 3000,
        paidCents: 3000,
        paymentMethod: "cash",
        receiveAt: 1720000000,
        expectedPickupAt: null,
        actualPickupAt: 1720003600,
        staffId: 7,
        pickedUpBy: 8,
        note: "虚构订单",
        createdAt: 1720000000,
        updatedAt: 1720003600,
      },
    ],
    orderItems: [
      {
        id: 11,
        orderId: 1,
        itemType: "虚构衬衫",
        serviceType: "wash",
        quantity: 2,
        unitPriceCents: 1500,
        subtotalCents: 3000,
        itemNotes: "虚构袖口说明",
      },
    ],
    orderPhotos: [{ id: 21, orderId: 1, filePath: "2024/item.png", takenAt: null }],
    settings: [{ key: "shop.name", value: "虚构测试店", updatedAt: null }],
  };
}

export async function seedMigrationTenant(pool: PgPool) {
  const orgId = randomUUID();
  const storeId = randomUUID();
  const staffId = randomUUID();
  await pool.query(
    `INSERT INTO orgs(id,code,name,created_at,updated_at) VALUES($1::uuid,$1::text,'Fixture',now(),now())`,
    [orgId],
  );
  await pool.query(
    `INSERT INTO stores(id,org_id,code,name,timezone,created_at,updated_at)
    VALUES($1,$2,'fixture','Fixture','Asia/Taipei',now(),now())`,
    [storeId, orgId],
  );
  await pool.query(
    `INSERT INTO staffs(id,org_id,username,password_hash,display_name,created_at,updated_at)
    VALUES($1,$2,'fixture','not-a-real-password-hash','Fixture',now(),now())`,
    [staffId, orgId],
  );
  await pool.query(
    `INSERT INTO staff_store_roles(id,org_id,store_id,staff_id,role,is_privacy_admin,created_at,updated_at)
    VALUES($1,$2,$3,$4,'admin',true,now(),now())`,
    [randomUUID(), orgId, storeId, staffId],
  );
  return { orgId, storeId, staffId };
}

export async function seedMigrationTicket(
  pool: PgPool,
  auth: import("./pg-v1-import.js").MigrationAuthorization,
) {
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO sessions(id,org_id,store_id,staff_id,device_id,session_version,
    permission_version,authentication_method,status,created_at)
    VALUES($1,$2,$3,$4,$5,1,1,'password','active',now())`,
    [sessionId, auth.orgId, auth.storeId, auth.staffId, randomUUID()],
  );
  await pool.query(
    `INSERT INTO v1_import_requests(id,org_id,store_id,actor_id,session_id,
    session_version,permission_version,source_sha256,plan_sha256,photos_sha256,approved_at,expires_at)
    VALUES($1,$2,$3,$4,$5,1,1,$6,$7,$8,now(),$9)`,
    [
      auth.requestId,
      auth.orgId,
      auth.storeId,
      auth.staffId,
      sessionId,
      auth.sourceSha256,
      auth.planSha256,
      auth.photoManifestSha256,
      new Date(auth.expiresAt),
    ],
  );
  return { sessionId };
}
