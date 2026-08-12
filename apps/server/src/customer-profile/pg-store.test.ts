import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgCustomerProfileStore } from "./pg-store.js";
import { CustomerIdentifierConflictError, type CustomerProfileSetStoreInput } from "./types.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_ADMIN_ID,
});

function profileInput(
  customerId: string,
  expectedVersion: number,
  identifierKind: "vehicle_plate" | "tag",
): CustomerProfileSetStoreInput {
  return Object.freeze({
    customer_id: customerId,
    expected_version: expectedVersion,
    gender: "unspecified",
    preferred_contact: "wechat",
    service_note: `Synthetic service note v${expectedVersion + 1}`,
    waivers: Object.freeze({
      skip_ticket_print: true,
      skip_label_print: false,
      skip_rack_assignment: true,
    }),
    addresses: [
      {
        label: expectedVersion === 0 ? "张三父母家" : "home",
        recipient: "Synthetic Profile Customer",
        contact_phone: "13800008901",
        address: `Synthetic Profile Road ${expectedVersion + 1}`,
        is_default: true,
      },
    ],
    identifiers: [{ kind: identifierKind, value: "TEST A-901" }],
    reason: "Synthetic profile acceptance",
    store_id: DEMO_STORE_ID,
    staff_id: DEMO_ADMIN_ID,
    at: 1_775_174_700 + expectedVersion,
  });
}

maybe(
  "real PG customer profile CAS, retired-PII purge, identifier scope and RLS are enforced",
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app });
    const customerA = randomUUID();
    const customerB = randomUUID();
    const otherOrg = randomUUID();
    const otherStore = randomUUID();
    const otherStaff = randomUUID();
    const otherCustomer = randomUUID();
    try {
      await seedPgTestIdentityFixture(adminPool);
      await adminPool.query(
        `INSERT INTO customers (id, org_id, phone, name, created_at, updated_at)
       VALUES
         ($1::uuid, $3::uuid, '13800008901', 'Profile A', now(), now()),
         ($2::uuid, $3::uuid, '13800008902', 'Profile B', now(), now())`,
        [customerA, customerB, DEMO_ORG_ID],
      );
      const profiles = createPgCustomerProfileStore(appPool, { orgId: DEMO_ORG_ID });
      const first = await profiles.setProfile(profileInput(customerA, 0, "vehicle_plate"));
      assert.equal(first?.version, 1);
      assert.equal(first?.addresses[0]?.address, "Synthetic Profile Road 1");
      assert.equal(await profiles.setProfile(profileInput(customerA, 0, "vehicle_plate")), null);

      const second = await profiles.setProfile(profileInput(customerA, 1, "vehicle_plate"));
      assert.equal(second?.version, 2);
      assert.equal(second?.addresses[0]?.address, "Synthetic Profile Road 2");
      const historical = await adminPool.query<
        Readonly<{
          retired_addresses: number;
          leaked_address_rows: number;
          retired_identifiers: number;
          leaked_identifier_rows: number;
        }>
      >(
        `SELECT
         (SELECT count(*)::integer FROM customer_addresses
           WHERE org_id = $1::uuid AND customer_id = $2::uuid
             AND retired_at IS NOT NULL) AS retired_addresses,
         (SELECT count(*)::integer FROM customer_addresses
           WHERE org_id = $1::uuid AND customer_id = $2::uuid
             AND retired_at IS NOT NULL
             AND (
               label IS NOT NULL OR recipient IS NOT NULL
               OR contact_phone IS NOT NULL OR address_body IS NOT NULL
             )
         ) AS leaked_address_rows,
         (SELECT count(*)::integer FROM customer_identifiers
           WHERE org_id = $1::uuid AND customer_id = $2::uuid
             AND retired_at IS NOT NULL) AS retired_identifiers,
         (SELECT count(*)::integer FROM customer_identifiers
           WHERE org_id = $1::uuid AND customer_id = $2::uuid
             AND retired_at IS NOT NULL
             AND (raw_value IS NOT NULL OR normalized_value IS NOT NULL)
         ) AS leaked_identifier_rows`,
        [DEMO_ORG_ID, customerA],
      );
      assert.deepEqual(historical.rows[0], {
        retired_addresses: 1,
        leaked_address_rows: 0,
        retired_identifiers: 1,
        leaked_identifier_rows: 0,
      });

      await assert.rejects(
        () => profiles.setProfile(profileInput(customerB, 0, "vehicle_plate")),
        CustomerIdentifierConflictError,
      );
      const crossKind = await profiles.setProfile(profileInput(customerB, 0, "tag"));
      assert.equal(crossKind?.version, 1);
      assert.deepEqual(
        await profiles.findCustomerIdsByIdentifier?.(" test-a901 "),
        [customerA, customerB].sort(),
      );
      const zeroOverride = await profiles.setDiscount({
        customer_id: customerA,
        expected_version: 2,
        discount_bps: 0,
        reason: "Explicitly block tier inheritance",
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_ADMIN_ID,
        at: 1_775_174_703,
      });
      assert.equal(zeroOverride?.version, 3);
      assert.equal(zeroOverride?.discount_bps, 0);

      await adminPool.query(
        `INSERT INTO orgs (id, code, name, created_at, updated_at)
       VALUES ($1::uuid, $2, 'Other Profile Org', now(), now())`,
        [otherOrg, `profile-${otherOrg.slice(0, 12)}`],
      );
      await adminPool.query(
        `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'main', 'Other Profile Store', 'UTC', now(), now())`,
        [otherStore, otherOrg],
      );
      await adminPool.query(
        `INSERT INTO staffs (
         id, org_id, username, password_hash, display_name, is_active,
         permission_version, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, 'profile-admin', 'test-only',
                 'Other Profile Admin', true, 1, now(), now())`,
        [otherStaff, otherOrg],
      );
      await adminPool.query(
        `INSERT INTO customers (id, org_id, phone, name, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, '13800008901', 'Other Profile Customer', now(), now())`,
        [otherCustomer, otherOrg],
      );
      await adminPool.query(
        `INSERT INTO customer_profiles (
         org_id, customer_id, version, gender, preferred_contact, service_note,
         origin_store_id, updated_by_staff_id, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, 1, 'unspecified', 'none', 'other private note',
                 $3::uuid, $4::uuid, now(), now())`,
        [otherOrg, otherCustomer, otherStore, otherStaff],
      );
      await adminPool.query(
        `INSERT INTO customer_erasure_tombstones (
           org_id, phone_hmac, customer_id, erased_at, erased_by_staff_id
         ) VALUES (
           $1::uuid, customer_phone_hmac($1::uuid, '13800008901'),
           $2::uuid, now(), $3::uuid
         )`,
        [otherOrg, otherCustomer, otherStaff],
      );
      const crossTenantFailure = async (phone: string) => {
        try {
          await withPoolClient(appPool, (client) =>
            withTenantTransaction(client, TENANT, (tx) =>
              tx.query(
                `INSERT INTO customers (id, org_id, phone, name, created_at, updated_at)
                 VALUES ($1::uuid, $2::uuid, $3, 'Cross tenant probe', now(), now())`,
                [randomUUID(), otherOrg, phone],
              ),
            ),
          );
          assert.fail("cross-tenant customer insert unexpectedly succeeded");
        } catch (error) {
          assert.ok(error instanceof Error);
          const code =
            "code" in error && typeof error.code === "string" ? error.code : "unknown-error";
          return Object.freeze({ code, message: error.message });
        }
      };
      assert.deepEqual(await crossTenantFailure("13800008901"), {
        code: "42501",
        message: "customer tenant unavailable",
      });
      assert.deepEqual(await crossTenantFailure("13800008999"), {
        code: "42501",
        message: "customer tenant unavailable",
      });
      const isolatedCount = await withPoolClient(appPool, (client) =>
        withTenantTransaction(client, TENANT, async (tx) => {
          const result = await tx.query<Readonly<{ count: number }>>(
            "SELECT count(*)::integer AS count FROM customer_profiles WHERE customer_id = $1::uuid",
            [otherCustomer],
          );
          return result.rows[0]?.count;
        }),
      );
      assert.equal(isolatedCount, 0);
      const forced = await adminPool.query<
        Readonly<{ relname: string; relforcerowsecurity: boolean }>
      >(
        `SELECT relname, relforcerowsecurity
         FROM pg_class
        WHERE relname = ANY($1::text[])
        ORDER BY relname`,
        [["customer_addresses", "customer_identifiers", "customer_profiles"]],
      );
      assert.equal(forced.rows.length, 3);
      assert.equal(
        forced.rows.every((row) => row.relforcerowsecurity),
        true,
      );
    } finally {
      await adminPool.query(
        "DELETE FROM customer_addresses WHERE org_id = $1::uuid AND customer_id = ANY($2::uuid[])",
        [DEMO_ORG_ID, [customerA, customerB]],
      );
      await adminPool.query(
        "DELETE FROM customer_identifiers WHERE org_id = $1::uuid AND customer_id = ANY($2::uuid[])",
        [DEMO_ORG_ID, [customerA, customerB]],
      );
      await adminPool.query(
        "DELETE FROM customer_profiles WHERE org_id = $1::uuid AND customer_id = ANY($2::uuid[])",
        [DEMO_ORG_ID, [customerA, customerB]],
      );
      await adminPool.query("DELETE FROM customers WHERE id = ANY($1::uuid[])", [
        [customerA, customerB],
      ]);
      await adminPool.query("DELETE FROM customer_erasure_tombstones WHERE org_id = $1::uuid", [
        otherOrg,
      ]);
      await adminPool.query("DELETE FROM customer_profiles WHERE org_id = $1::uuid", [otherOrg]);
      await adminPool.query("DELETE FROM customers WHERE org_id = $1::uuid", [otherOrg]);
      await adminPool.query("DELETE FROM staffs WHERE org_id = $1::uuid", [otherOrg]);
      await adminPool.query("DELETE FROM stores WHERE org_id = $1::uuid", [otherOrg]);
      await adminPool.query("DELETE FROM customer_privacy_hmac_keys WHERE org_id = $1::uuid", [
        otherOrg,
      ]);
      await adminPool.query("DELETE FROM orgs WHERE id = $1::uuid", [otherOrg]);
      await Promise.all([appPool.end(), adminPool.end()]);
    }
  },
);
