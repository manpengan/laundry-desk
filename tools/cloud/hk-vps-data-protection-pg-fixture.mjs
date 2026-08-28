import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HK_VPS_CLOUD_TEST as PROFILE } from "./cloud-environment-profile.mjs";

const DATABASE = PROFILE.services.postgresDatabase;

export const DATA_PROTECTION_PG_ORIGINAL_PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
export const DATA_PROTECTION_PG_MUTATED_PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

export function dataProtectionPgPhotoSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function seedDataProtectionPgFixture(adapter, photoRoot) {
  const identity = await adapter.query(
    DATABASE,
    `SELECT store.org_id::text, store.id::text AS store_id, role.staff_id::text
       FROM stores store
       JOIN staff_store_roles role
         ON role.org_id = store.org_id AND role.store_id = store.id
      WHERE role.is_active
      ORDER BY store.id, role.staff_id
      LIMIT 1`,
  );
  const tenant = identity.rows[0];
  if (identity.rows.length !== 1 || tenant === undefined) {
    throw Object.assign(new Error("CLOUD_DATA_PG_FIXTURE_INVALID"), {
      code: "CLOUD_DATA_PG_FIXTURE_INVALID",
    });
  }
  const ids = Object.freeze({
    order: randomUUID(),
    line: randomUUID(),
    garment: randomUUID(),
    photo: randomUUID(),
  });
  const storageKey = `${ids.photo}.jpg`;
  await writeFile(join(photoRoot, storageKey), DATA_PROTECTION_PG_ORIGINAL_PHOTO, {
    mode: 0o600,
  });
  await adapter.query(
    DATABASE,
    `INSERT INTO orders (
       id, org_id, store_id, ticket_no, status, customer_phone, customer_name, note,
       subtotal_cents, payable_cents, paid_cents, balance_cents,
       created_at, updated_at, created_by_staff_id, business_date
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'open', NULL, NULL, NULL,
       1000, 1000, 0, 1000, now(), now(), $5::uuid,
       (SELECT to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD') FROM stores WHERE id=$3::uuid))`,
    [ids.order, tenant.org_id, tenant.store_id, `data-${ids.order.slice(0, 8)}`, tenant.staff_id],
  );
  await adapter.query(
    DATABASE,
    `INSERT INTO order_lines (
       id, org_id, store_id, order_id, line_index, service_code, category_code,
       unit_price_cents, qty, line_total_cents
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 0, 'wash', 'shirt', 1000, 1, 1000)`,
    [ids.line, tenant.org_id, tenant.store_id, ids.order],
  );
  await adapter.query(
    DATABASE,
    `INSERT INTO garments (
       id, org_id, store_id, order_id, order_line_id, seq, barcode,
       service_code, category_code, unit_price_cents, status
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1, $6,
       'wash', 'shirt', 1000, 'received')`,
    [
      ids.garment,
      tenant.org_id,
      tenant.store_id,
      ids.order,
      ids.line,
      ids.garment.replaceAll("-", ""),
    ],
  );
  await adapter.query(
    DATABASE,
    `INSERT INTO garment_photos (
       id, org_id, store_id, garment_id, order_id, kind, storage_key,
       content_type, byte_size, content_sha256, taken_at, created_by_staff_id
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'receive', $6,
       'image/jpeg', $7, $8, now(), $9::uuid)`,
    [
      ids.photo,
      tenant.org_id,
      tenant.store_id,
      ids.garment,
      ids.order,
      storageKey,
      DATA_PROTECTION_PG_ORIGINAL_PHOTO.length,
      dataProtectionPgPhotoSha256(DATA_PROTECTION_PG_ORIGINAL_PHOTO),
      tenant.staff_id,
    ],
  );
  return Object.freeze({ ...ids, storageKey });
}
