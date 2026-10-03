import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { seedBackupPhotoFixture } from "./backup-acceptance.mjs";

test("backup photo fixture rejects interpolated identifiers before SQL", async () => {
  await assert.rejects(seedBackupPhotoFixture(() => assert.fail("SQL must not run"), "'"));
});

test(
  "real PostgreSQL backup fixture satisfies the complete photo garment order parent chain",
  { skip: process.env.LAUNDRY_USE_LOCAL_PG !== "1" },
  async () => {
    const { Pool } = createRequire(resolve("apps/server/package.json"))("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 1 });
    const client = await pool.connect();
    const id = randomUUID();
    const photo = `INSERT INTO public.garment_photos
      (id, org_id, store_id, garment_id, order_id, kind, storage_key, content_type,
       content_sha256, byte_size, taken_at, created_by_staff_id)
      SELECT '${id}', s.org_id, s.id, '${id}', '${id}', 'receive', '${id}.png',
       'image/png', '${"a".repeat(64)}', 68, now(), f.id
      FROM public.stores s JOIN public.staffs f ON f.org_id=s.org_id
      ORDER BY s.id,f.id LIMIT 1`;
    try {
      await client.query("BEGIN");
      await client.query("SAVEPOINT missing_parents");
      await assert.rejects(
        client.query(photo),
        (error) => error.code === "23503" && error.constraint === "garment_photos_garment_order_fk",
      );
      await client.query("ROLLBACK TO SAVEPOINT missing_parents");
      await seedBackupPhotoFixture((sql) => client.query(sql), id);
      assert.equal((await client.query(photo)).rowCount, 1);
      const complete = await client.query(
        `SELECT count(*)::integer AS count FROM garment_photos p
         JOIN garments g ON (g.org_id,g.store_id,g.order_id,g.id)=(p.org_id,p.store_id,p.order_id,p.garment_id)
         JOIN order_lines l ON (l.org_id,l.store_id,l.order_id,l.id)=(g.org_id,g.store_id,g.order_id,g.order_line_id)
         JOIN orders o ON (o.org_id,o.store_id,o.id)=(l.org_id,l.store_id,l.order_id)
         WHERE p.id=$1`,
        [id],
      );
      assert.equal(complete.rows[0].count, 1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  },
);
