import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgDeliveryAddressResolver } from "./address-resolver.js";

const pgUrls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

const withAppTransaction = <T>(
  pool: PgPool,
  operation: (client: SqlClient) => Promise<T>,
): Promise<T> => withPoolClient(pool, (client) => withTenantTransaction(client, TENANT, operation));

type Fixture = Readonly<{
  rootCustomerId: string;
  sourceCustomerId: string;
  rootAddressId: string;
  sourceAddressId: string;
  appointmentId: string;
}>;

function fixture(): Fixture {
  return Object.freeze({
    rootCustomerId: randomUUID(),
    sourceCustomerId: randomUUID(),
    rootAddressId: randomUUID(),
    sourceAddressId: randomUUID(),
    appointmentId: randomUUID(),
  });
}

function rejectsWith(code: string, message: RegExp) {
  return (error: unknown): boolean => {
    const pgError = error as Readonly<{ code?: unknown; message?: unknown }>;
    assert.equal(pgError.code, code);
    assert.match(String(pgError.message), message);
    return true;
  };
}

async function seedMergedAddresses(adminPool: PgPool, rows: Fixture): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      `INSERT INTO customers (
         id, org_id, phone, name, version, merged_into_id, merged_at, created_at, updated_at
       ) VALUES
         ($1::uuid,$3::uuid,$4,'Appointment Root',1,NULL,NULL,now(),now()),
         ($2::uuid,$3::uuid,$5,'Appointment Source',2,$1::uuid,now(),now(),now())`,
      [
        rows.rootCustomerId,
        rows.sourceCustomerId,
        DEMO_ORG_ID,
        `188${rows.rootCustomerId.replaceAll("-", "").slice(0, 8)}`,
        `189${rows.sourceCustomerId.replaceAll("-", "").slice(0, 8)}`,
      ],
    );
    await client.query(
      `INSERT INTO customer_addresses (
         id, org_id, customer_id, profile_version, label, recipient,
         contact_phone, address_body, is_default, created_at, updated_at
       ) VALUES
         ($1::uuid,$5::uuid,$3::uuid,1,'根档案',NULL,NULL,'合成地址 A',true,now(),now()),
         ($2::uuid,$5::uuid,$4::uuid,1,'来源档案',NULL,NULL,'合成地址 B',false,now(),now())`,
      [
        rows.rootAddressId,
        rows.sourceAddressId,
        rows.rootCustomerId,
        rows.sourceCustomerId,
        DEMO_ORG_ID,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(adminPool: PgPool, rows: Fixture): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query("DELETE FROM delivery_appointments WHERE id = $1::uuid", [
      rows.appointmentId,
    ]);
    await client.query("DELETE FROM customer_addresses WHERE id = ANY($1::uuid[])", [
      [rows.rootAddressId, rows.sourceAddressId],
    ]);
    await client.query("DELETE FROM customers WHERE id = $1::uuid", [rows.sourceCustomerId]);
    await client.query("DELETE FROM customers WHERE id = $1::uuid", [rows.rootCustomerId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

test(
  "real PostgreSQL canonical addresses and appointment state machine fail closed",
  { skip: pgUrls === null },
  async () => {
    assert.ok(pgUrls);
    const adminPool = createPgPool({ connectionString: pgUrls.admin });
    const appPool = createPgPool({ connectionString: pgUrls.app });
    const rows = fixture();
    const start = new Date(Date.now() + 86_400_000);
    const end = new Date(start.getTime() + 3_600_000);
    let fixtureSeeded = false;
    try {
      await seedPgTestIdentityFixture(adminPool);
      await seedMergedAddresses(adminPool, rows);
      fixtureSeeded = true;
      await withAppTransaction(appPool, async (client) => {
        const resolver = createPgDeliveryAddressResolver();
        const listed = await resolver.list(client, TENANT, rows.sourceCustomerId);
        assert.equal(listed?.customer_id, rows.rootCustomerId);
        assert.deepEqual(
          listed?.addresses.map(({ address_id }) => address_id),
          [rows.rootAddressId, rows.sourceAddressId],
        );
        assert.deepEqual(
          await resolver.resolve(client, TENANT, rows.sourceCustomerId, rows.sourceAddressId),
          { customer_id: rows.rootCustomerId, address_id: rows.sourceAddressId },
        );
        await client.query(
          `INSERT INTO delivery_appointments (
             id, org_id, store_id, customer_id, address_id, direction, service_area_code,
             scheduled_start_at, scheduled_end_at, fee_cents, status, version, policy_version,
             created_at, updated_at, created_by_staff_id, updated_by_staff_id
           ) VALUES (
             $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'pickup','north',
             $6,$7,800,'scheduled',1,1,'2000-01-01','2000-01-01',$8::uuid,$8::uuid
           )`,
          [
            rows.appointmentId,
            DEMO_ORG_ID,
            DEMO_STORE_ID,
            rows.rootCustomerId,
            rows.sourceAddressId,
            start,
            end,
            DEMO_STAFF_A_ID,
          ],
        );
      });

      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `UPDATE delivery_appointments
                SET address_id = $4::uuid, version = 2, updated_by_staff_id = $5::uuid
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.appointmentId, rows.rootAddressId, DEMO_STAFF_A_ID],
            ),
          ),
        rejectsWith("42501", /identity is immutable/u),
      );
      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `UPDATE delivery_appointments
                SET created_at = '2000-01-01', version = 2, updated_by_staff_id = $4::uuid
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.appointmentId, DEMO_STAFF_A_ID],
            ),
          ),
        rejectsWith("42501", /identity is immutable/u),
      );
      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `UPDATE delivery_appointments
                SET scheduled_start_at = $4, scheduled_end_at = $5,
                    updated_at = '2000-01-01', updated_by_staff_id = $6::uuid
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [
                DEMO_ORG_ID,
                DEMO_STORE_ID,
                rows.appointmentId,
                new Date(start.getTime() + 3_600_000),
                new Date(end.getTime() + 3_600_000),
                DEMO_STAFF_A_ID,
              ],
            ),
          ),
        rejectsWith("23514", /version must advance by one/u),
      );

      const rescheduled = await withAppTransaction(appPool, (client) =>
        client.query<Readonly<{ updated_at: Date }>>(
          `UPDATE delivery_appointments
              SET scheduled_start_at = $4, scheduled_end_at = $5, version = 2,
                  updated_at = '2000-01-01', updated_by_staff_id = $6::uuid
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
            RETURNING updated_at`,
          [
            DEMO_ORG_ID,
            DEMO_STORE_ID,
            rows.appointmentId,
            new Date(start.getTime() + 3_600_000),
            new Date(end.getTime() + 3_600_000),
            DEMO_STAFF_A_ID,
          ],
        ),
      );
      assert.ok((rescheduled.rows[0]?.updated_at.getTime() ?? 0) > Date.parse("2000-01-01"));

      await withAppTransaction(appPool, (client) =>
        client.query(
          `UPDATE delivery_appointments
              SET status = 'cancelled', cancellation_reason = 'customer_request',
                  cancelled_at = '2000-01-01', cancelled_by_staff_id = $4::uuid,
                  version = 3, updated_at = '2000-01-01', updated_by_staff_id = $4::uuid
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, rows.appointmentId, DEMO_STAFF_A_ID],
        ),
      );
      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `UPDATE delivery_appointments
                SET status = 'scheduled', cancellation_reason = NULL, cancelled_at = NULL,
                    cancelled_by_staff_id = NULL, version = 4, updated_by_staff_id = $4::uuid
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.appointmentId, DEMO_STAFF_A_ID],
            ),
          ),
        rejectsWith("42501", /cancelled delivery appointment is immutable/u),
      );
    } finally {
      if (fixtureSeeded) await cleanup(adminPool, rows);
      await appPool.end();
      await adminPool.end();
    }
  },
);
