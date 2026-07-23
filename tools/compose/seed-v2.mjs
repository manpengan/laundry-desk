import { createPgPool } from "../../apps/server/dist/db/pg-pool.js";
import { seedDemoIdentity } from "../../apps/server/dist/local/pg-seed.js";

const databaseUrl =
  process.env.DATABASE_ADMIN_URL ??
  "postgresql://postgres:postgres_secure_password@postgres:5432/laundry_v2";

const pool = createPgPool({ connectionString: databaseUrl });

try {
  const seed = await seedDemoIdentity(pool);
  process.stdout.write(`seeded ${seed.org_id}/${seed.store_id} (${seed.staff_ids.length} staff)\n`);
} finally {
  await pool.end();
}
