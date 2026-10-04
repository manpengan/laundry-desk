import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { createIsolatedPgTestDatabase } from "../db/isolated-pg-test-database.js";
import { createPgLocalRuntime, createMemoryLocalRuntime } from "../local/create-runtime.js";
import { parseLocalServerConfig } from "../local/config.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import type { AuthorizedSession } from "../auth/session-view.js";
import { TestByokKms } from "../ai/byok-test-kms.js";
import { createPgMemberStore } from "../member/pg-store.js";
import { createPgCustomerPortalStore } from "../customer-self-service/pg-store.js";
import { createMiniappIdentityService } from "./identity.js";
import { createMiniappSettingsService } from "./settings.js";
import { createMiniappService } from "./service.js";
import { MINIAPP_TENANT } from "./types.js";
import { delegation } from "./authority.js";
import {
  exerciseAppointments,
  exerciseBenefits,
  exercisePaymentIntents,
} from "./actions-pg-test-support.js";
import { deriveMiniappProfileAuthorityKey, signMiniappProfileUpdate } from "./profile-authority.js";
const urls = resolvePgUrls();
test(
  "miniapp actual PG binds verified customers, rechecks delegation and commits money, receipts and audit atomically",
  { skip: urls === null },
  async (t) => {
    assert.ok(urls);
    const fixture = await createIsolatedPgTestDatabase(urls);
    t.after(fixture.close);
    const admin = createPgPool({ connectionString: fixture.urls.admin }),
      pool = createPgPool({ connectionString: fixture.urls.app });
    const memory = await createMemoryLocalRuntime();
    const password = "synthetic-miniapp-admin";
    const { orgId, storeId, adminStaffId: staffId } = LOCAL_PROFILE;
    const customerId = randomUUID(),
      otherId = randomUUID(),
      accountId = randomUUID(),
      deviceId = randomUUID(),
      sessionId = randomUUID(),
      familyId = randomUUID();
    await admin.query(
      `INSERT INTO orgs(id,code,name,created_at,updated_at) VALUES($1,'local','Fixture',now(),now())`,
      [orgId],
    );
    await admin.query(
      `INSERT INTO stores(id,org_id,code,name,timezone,created_at,updated_at) VALUES($1,$2,'main','Fixture','Asia/Taipei',now(),now())`,
      [storeId, orgId],
    );
    await admin.query(
      `INSERT INTO staffs(id,org_id,username,password_hash,display_name,created_at,updated_at) VALUES($1,$2,'fixture',$3,'Fixture',now(),now())`,
      [staffId, orgId, await memory.identity.login.passwordPort.hashPassword(password)],
    );
    await admin.query(
      `INSERT INTO staff_store_roles(id,org_id,store_id,staff_id,role,is_privacy_admin,created_at,updated_at) VALUES($1,$2,$3,$4,'admin',true,now(),now())`,
      [randomUUID(), orgId, storeId, staffId],
    );
    await admin.query(
      `INSERT INTO store_features(id,org_id,store_id,membership,customer_portal,updated_at) VALUES($1,$2,$3,true,false,now())`,
      [randomUUID(), orgId, storeId],
    );
    for (const [id, phone] of [
      [customerId, "13800000001"],
      [otherId, "13800000002"],
    ])
      await admin.query(
        `INSERT INTO customers(id,org_id,phone,name,created_at,updated_at) VALUES($1,$2,$3,'虚构顾客',now(),now())`,
        [id, orgId, phone],
      );
    await admin.query(
      `INSERT INTO sessions(id,org_id,store_id,staff_id,device_id,session_version,permission_version,authentication_method,status,created_at) VALUES($1,$2,$3,$4,$5,1,1,'password','active',now())`,
      [sessionId, orgId, storeId, staffId, deviceId],
    );
    await admin.query(
      `INSERT INTO refresh_families(id,session_id,org_id,store_id,status,created_at) VALUES($1,$2,$3,$4,'active',now())`,
      [familyId, sessionId, orgId, storeId],
    );
    const config = parseLocalServerConfig({
      LAUNDRY_ACCESS_TOKEN_SECRET: randomBytes(32).toString("hex"),
      LAUNDRY_CSRF_PROOF_SECRET: randomBytes(32).toString("hex"),
    });
    const local = await createPgLocalRuntime(
      fixture.urls.app,
      false,
      config,
      {
        createPool: () => pool,
        assertReady: async () => {},
        loadStaffDirectory: async () => [
          {
            staff_id: staffId,
            display_name: "Fixture",
            role: "admin",
            username: "fixture",
            privacy_admin: true,
          },
        ],
      },
      {},
    );
    const kms = new TestByokKms("windows-dpapi-current-user", "1");
    const settings = createMiniappSettingsService(local, kms);
    const provider = {
      identity: async (_credential: unknown, code: string) =>
        code.startsWith("other") ? "other-openid-fixture-0001" : "first-openid-fixture-0001",
      phone: async (_credential: unknown, code: string) =>
        code.startsWith("other") ? "13800000002" : "13800000001",
    };
    const authorityKey = deriveMiniappProfileAuthorityKey(config.accessTokenSecret);
    try {
      await admin.query(
        `INSERT INTO miniapp_profile_authority(org_id,store_id,hmac_key) VALUES($1,$2,$3)`,
        [orgId, storeId, authorityKey],
      );
    } finally {
      authorityKey.fill(0);
    }
    const identity = createMiniappIdentityService(local, kms, provider);
    const service = createMiniappService(local, kms, identity);
    const auth: AuthorizedSession = {
      session: {
        session_id: sessionId,
        family_id: familyId,
        org_id: orgId,
        store_id: storeId,
        staff_id: staffId,
        device_id: deviceId,
        session_version: 1,
        permission_version: 1,
        authentication_method: "password",
        status: "active",
        created_at: 1,
        revoked_at: null,
      },
      authority: {
        staff_id: staffId,
        display_name: "Fixture",
        role: "admin",
        permission_version: 1,
        is_privacy_admin: true,
      },
    };
    const save = {
      password,
      expected_version: 0,
      enabled: true,
      transactions_enabled: true,
      delegated_staff_id: staffId,
      app_id: "wx0123456789abcdef",
      app_secret: "synthetic-secret-fixture-0001",
      subscription_template_ids: ["template_fixture"],
    };
    let ticket = 100000;
    const order = async (owner: string = customerId, amount = 1234) => {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO orders(id,org_id,store_id,ticket_no,pickup_code,status,customer_id,subtotal_cents,original_cents,payable_cents,paid_cents,balance_cents,created_at,updated_at,created_by_staff_id,business_date)
    VALUES($1::uuid,$2,$3,$1::uuid::text,$4,'open',$5,$6,$6,$6,0,$6,now(),now(),$7,'2026-10-03')`,
        [id, orgId, storeId, String(++ticket), owner, amount, staffId],
      );
      return id;
    };
    try {
      await assert.rejects(settings.save(auth, { ...save, password: "wrong" }), /POLICY_DENIED/u);
      const view = await settings.save(auth, save);
      assert.equal(view.version, 1);
      assert.doesNotMatch(JSON.stringify(view), /app_secret|envelope|password/u);
      assert.deepEqual(await identity.login({ code: "first-unbound" }), { binding_required: true });
      const first = await identity.login({ code: "first-bound", phone_code: "first-phone" });
      assert.ok("access_token" in first);
      const token = first.access_token;
      await assert.rejects(
        identity.login({ code: "first-bound", phone_code: "first-phone" }),
        /AUTHENTICATION_FAILED/u,
      );
      await assert.rejects(
        identity.transact(`m1.${randomBytes(32).toString("base64url")}`, async () => true),
        /AUTHENTICATION_FAILED/u,
      );
      const other = await identity.login({ code: "other-bound", phone_code: "other-phone" });
      assert.ok("access_token" in other);
      await t.test(
        "fixed session owns only its current canonical customer and legacy portal remains disabled",
        async () => {
          const mine = await order(),
            theirs = await order(otherId);
          assert.equal(
            (
              await service.query(token, {
                name: "customer.self_service.order.get",
                input: { order_id: mine },
              })
            ).execution,
            "executed",
          );
          await assert.rejects(
            service.query(token, {
              name: "customer.self_service.order.get",
              input: { order_id: theirs },
            }),
            /RESOURCE_UNAVAILABLE/u,
          );
          await assert.rejects(
            service.query(other.access_token, {
              name: "customer.self_service.order.get",
              input: { order_id: mine },
            }),
            /RESOURCE_UNAVAILABLE/u,
          );
          assert.equal(
            (
              await admin.query(`SELECT customer_portal FROM store_features WHERE store_id=$1`, [
                storeId,
              ])
            ).rows[0].customer_portal,
            false,
          );
          const legacyOrder = (
            await admin.query<{ pickup_code: string }>(
              "SELECT pickup_code FROM orders WHERE id=$1",
              [mine],
            )
          ).rows[0]!;
          assert.equal(
            await createPgCustomerPortalStore(pool).createSession(
              {
                org_code: "local",
                store_code: "main",
                phone: "13800000001",
                pickup_code: legacyOrder.pickup_code,
              },
              {
                sessionHash: randomBytes(32).toString("hex"),
                csrfHash: randomBytes(32).toString("hex"),
                authorityHash: randomBytes(32).toString("hex"),
              },
            ),
            null,
          );
        },
      );
      await t.test(
        "profile CAS preserves staff addresses and stores no address/phone in immutable receipts",
        async () => {
          const staffAddress = randomUUID();
          await admin.query(
            `INSERT INTO customer_addresses(id,org_id,customer_id,profile_version,label,address_body,created_at,updated_at)
            VALUES($1,$2,$3,1,'柜台地址','合成柜台地址',now(),now())`,
            [staffAddress, orgId, customerId],
          );
          const body = {
            expected_version: 0,
            preferred_contact: "wechat" as const,
            addresses: [
              {
                label: "家",
                recipient: "虚构",
                contact_phone: "13800000001",
                address: "虚构地址",
                is_default: true,
              },
            ],
          };
          const result = await service.transaction(token, "profile/update", body);
          assert.equal((result as { version: number }).version, 1);
          assert.deepEqual(await service.transaction(token, "profile/update", body), result);
          await assert.rejects(
            service.transaction(token, "profile/update", { ...body, preferred_contact: "sms" }),
            /IDEMPOTENCY_CONFLICT/u,
          );
          const receipt = await admin.query(
            `SELECT result_json FROM miniapp_transaction_receipts WHERE action='profile/update'`,
          );
          assert.deepEqual(receipt.rows[0].result_json, { version: 1 });
          assert.deepEqual(
            (
              await admin.query(
                `SELECT address_body,retired_at,portal_managed FROM customer_addresses WHERE id=$1`,
                [staffAddress],
              )
            ).rows[0],
            { address_body: "合成柜台地址", retired_at: null, portal_managed: false },
          );
          await assert.rejects(
            identity.transact(token, ({ client }) =>
              client.query(
                `UPDATE customer_addresses SET label='tamper' WHERE org_id=$1 AND portal_managed`,
                [orgId],
              ),
            ),
            { code: "42501" },
          );
        },
      );
      await t.test(
        "app-only forged sessions and readable DB data cannot authorize protected profile DML",
        async () => {
          await assert.rejects(
            identity.transaction(({ client }) =>
              client.query("SELECT hmac_key FROM miniapp_profile_authority"),
            ),
            { code: "42501" },
          );
          await assert.rejects(
            identity.transaction(async ({ client }) => {
              const row = (
                await client.query<{ id: string }>(
                  `SELECT id::text FROM miniapp_sessions WHERE customer_id=$1 LIMIT 1`,
                  [customerId],
                )
              ).rows[0];
              assert.ok(row);
              const forgedBinding = randomUUID(),
                forgedSession = randomUUID();
              await client.query(
                `INSERT INTO miniapp_bindings(id,org_id,store_id,app_id,openid_sha256,encrypted_openid_json,customer_id)
                SELECT $1::uuid,b.org_id,b.store_id,b.app_id,$2,b.encrypted_openid_json,b.customer_id
                FROM miniapp_bindings b JOIN miniapp_sessions s ON s.binding_id=b.id WHERE s.id=$3::uuid`,
                [forgedBinding, "0".repeat(64), row.id],
              );
              await client.query(
                `INSERT INTO miniapp_sessions(id,org_id,store_id,binding_id,customer_id,config_version,expires_at)
                SELECT $1::uuid,org_id,store_id,$2::uuid,customer_id,config_version,statement_timestamp()+interval '5 minutes'
                FROM miniapp_sessions WHERE id=$3::uuid`,
                [forgedSession, forgedBinding, row.id],
              );
              await client.query(
                "SELECT set_config('app.customer_id',$1,true),set_config('app.staff_id',$2,true)",
                [customerId, staffId],
              );
              await client.query(`SELECT * FROM miniapp_profile_update($1,1,'none','[]','{}',$2)`, [
                forgedSession,
                "0".repeat(64),
              ]);
              throw new Error("FORGED_PROFILE_PROOF_ACCEPTED");
            }),
            { code: "42501" },
          );
          await assert.rejects(
            identity.transact(token, async (tx) => {
              await delegation(tx);
              const body = {
                expected_version: 1,
                preferred_contact: "none" as const,
                addresses: [],
              };
              const proof = await signMiniappProfileUpdate(local.accessTokenSecret, tx, body);
              await tx.client.query(`SELECT * FROM miniapp_profile_update($1,1,'sms','[]',$2,$3)`, [
                tx.identity.sessionId,
                proof.payload,
                proof.signature,
              ]);
            }),
            { code: "42501" },
          );
          for (const override of [
            { expires_at_ms: Date.now() - 1000 },
            { expires_at_ms: Date.now() + 120000 },
            { session_id: randomUUID() },
            { customer_id: otherId },
            { config_version: 2 },
          ]) {
            await assert.rejects(
              identity.transact(token, async (tx) => {
                await delegation(tx);
                const body = {
                  expected_version: 1,
                  preferred_contact: "none" as const,
                  addresses: [],
                };
                const original = await signMiniappProfileUpdate(local.accessTokenSecret, tx, body);
                const claims: Record<string, unknown> = JSON.parse(original.payload);
                const payload = JSON.stringify({ ...claims, ...override });
                const key = deriveMiniappProfileAuthorityKey(local.accessTokenSecret);
                try {
                  const signature = createHmac("sha256", key).update(payload).digest("hex");
                  await tx.client.query(
                    "SELECT * FROM miniapp_profile_update($1,1,'none','[]',$2,$3)",
                    [tx.identity.sessionId, payload, signature],
                  );
                } finally {
                  key.fill(0);
                }
              }),
              { code: "42501" },
            );
          }
          // The failed second call rolls the whole transaction back, retaining the address fixture.
          await assert.rejects(
            identity.transact(token, async (tx) => {
              await delegation(tx);
              const body = {
                expected_version: 1,
                preferred_contact: "none" as const,
                addresses: [],
              };
              const proof = await signMiniappProfileUpdate(local.accessTokenSecret, tx, body);
              const args = [tx.identity.sessionId, proof.payload, proof.signature];
              const sql = "SELECT version FROM miniapp_profile_update($1,1,'none','[]',$2,$3)";
              assert.equal(
                (await tx.client.query<{ version: number }>(sql, args)).rows[0]?.version,
                2,
              );
              await tx.client.query(sql, args);
            }),
            { code: "40001" },
          );
        },
      );
      await identity.transact(token, async (tx) => {
        const authority = await delegation(tx);
        const store = createPgMemberStore(tx.client, authority.tenant, { newId: () => accountId });
        assert.equal(
          (
            await store.openAccount({
              customer_id: customerId,
              store_id: storeId,
              at: Math.floor(Date.now() / 1000),
            })
          ).ok,
          true,
        );
        const seeded = createPgMemberStore(tx.client, authority.tenant);
        assert.equal(
          (
            await seeded.topup({
              account_id: accountId,
              store_id: storeId,
              amount_cents: 10000,
              tender: "cash",
              staff_id: staffId,
              at: Math.floor(Date.now() / 1000),
              business_date: "2026-10-03",
              note: null,
            })
          ).ok,
          true,
        );
      });
      await t.test(
        "balance payment is atomic, idempotent and cannot pay somebody else",
        async () => {
          const mine = await order(),
            theirs = await order(otherId),
            key = randomUUID();
          const [paid, concurrent] = await Promise.all(
            [0, 1].map(() =>
              service.transaction(token, "balance/pay", {
                idempotency_key: key,
                order_id: mine,
              }),
            ),
          );
          assert.deepEqual(concurrent, paid);
          assert.equal((paid as { paid_cents: number }).paid_cents, 1234);
          assert.deepEqual(
            await service.transaction(token, "balance/pay", {
              idempotency_key: key,
              order_id: mine,
            }),
            paid,
          );
          await assert.rejects(
            service.transaction(token, "balance/pay", { idempotency_key: key, order_id: theirs }),
            /IDEMPOTENCY_CONFLICT/u,
          );
          await assert.rejects(
            service.transaction(token, "balance/pay", {
              idempotency_key: randomUUID(),
              order_id: theirs,
            }),
            /RESOURCE_UNAVAILABLE/u,
          );
          assert.equal(
            (await admin.query(`SELECT count(*)::int n FROM payments WHERE order_id=$1`, [mine]))
              .rows[0].n,
            1,
          );
          const receipt = (
            await admin.query(
              `SELECT * FROM miniapp_transaction_receipts WHERE idempotency_key=$1`,
              [key],
            )
          ).rows[0];
          assert.equal(receipt.customer_id, customerId);
          assert.equal(receipt.delegated_staff_id, staffId);
          assert.equal(receipt.permission_version, 1);
        },
      );
      const actionFixture = {
        admin,
        local,
        kms,
        identity,
        service,
        token,
        otherToken: other.access_token,
        customerId,
        otherId,
        accountId,
        order,
      };
      await t.test(
        "appointments create/cancel use the authenticated customer and immutable receipts",
        () => exerciseAppointments(actionFixture),
      );
      await t.test(
        "coupon, punch and points use owned assets with idempotent real ledger effects",
        () => exerciseBenefits(actionFixture),
      );
      await t.test(
        "payment and topup intents reserve owned resources without treating uncertainty as payment",
        () => exercisePaymentIntents(actionFixture),
      );
      await t.test("audit failure rolls back domain ledger, order and receipt", async () => {
        const id = await order(),
          key = randomUUID();
        await admin.query(
          `ALTER TABLE audit_log ADD CONSTRAINT miniapp_fixture_failure CHECK(command<>'miniapp.balance/pay') NOT VALID`,
        );
        try {
          await assert.rejects(
            service.transaction(token, "balance/pay", { idempotency_key: key, order_id: id }),
            { code: "23514" },
          );
          assert.equal(
            (await admin.query(`SELECT paid_cents FROM orders WHERE id=$1`, [id])).rows[0]
              .paid_cents,
            0,
          );
          assert.equal(
            (
              await admin.query(
                `SELECT count(*)::int n FROM miniapp_transaction_receipts WHERE idempotency_key=$1`,
                [key],
              )
            ).rows[0].n,
            0,
          );
        } finally {
          await admin.query("ALTER TABLE audit_log DROP CONSTRAINT miniapp_fixture_failure");
        }
      });
      await t.test("staff/config/session revocation and process restart fail closed", async () => {
        await admin.query("UPDATE staffs SET is_active=false WHERE id=$1", [staffId]);
        await assert.rejects(
          service.transaction(token, "balance/pay", {
            idempotency_key: randomUUID(),
            order_id: await order(),
          }),
          /PERMISSION_DENIED/u,
        );
        await admin.query("UPDATE staffs SET is_active=true WHERE id=$1", [staffId]);
        await identity.logout(other.access_token);
        await assert.rejects(
          service.query(other.access_token, {
            name: "customer.self_service.profile.get",
            input: {},
          }),
          /AUTHENTICATION_FAILED/u,
        );
        await assert.rejects(
          identity.transaction(({ client }) =>
            client.query(
              `UPDATE miniapp_sessions SET status='active',revoked_at=NULL WHERE status='revoked'`,
            ),
          ),
          { code: "42501" },
        );
        const restarted = createMiniappIdentityService(local, kms, provider);
        await assert.rejects(
          restarted.transact(token, async () => true),
          /AUTHENTICATION_FAILED/u,
        );
        await settings.save(auth, {
          ...save,
          expected_version: 1,
          enabled: false,
          transactions_enabled: false,
        });
        await assert.rejects(
          service.query(token, { name: "customer.self_service.profile.get", input: {} }),
          /AUTHENTICATION_FAILED/u,
        );
      });
      await assert.rejects(
        identity.transaction(({ client }) =>
          client.query("UPDATE miniapp_transaction_receipts SET permission_version=9"),
        ),
        { code: "42501" },
      );
      assert.equal(MINIAPP_TENANT.storeId, storeId);
    } finally {
      identity.clear();
      await pool.end();
      await admin.end();
    }
  },
);
