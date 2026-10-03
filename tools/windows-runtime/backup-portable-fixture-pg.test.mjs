import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  mutatePortableFixtureNote,
  readPortableFixtureNote,
  seedBackupPhotoFixture,
} from "./backup-acceptance.mjs";
import { exportPortableDatabase, importPortableDatabase } from "./portable-database.mjs";

test(
  "portable acceptance business mutation preserves commissioned identity through real export/import",
  { skip: process.env.LAUNDRY_USE_LOCAL_PG !== "1", timeout: 120_000 },
  async () => {
    const { Pool } = createRequire(resolve("apps/server/package.json"))("pg");
    const { loadMigrationBundle, applyRuntimeMigrations, verifyRuntimeMigrationLedger } =
      await import("../../apps/server/dist/runtime/migration-bundle.js");
    const { bootstrapLocalIdentity, localRuntimeCommissioningState } =
      await import("../../apps/server/dist/local/bootstrap.js");
    const { createPasswordPort } = await import("../../apps/server/dist/identity/password.js");
    const { LOCAL_PROFILE } = await import("../../apps/server/dist/local/profile.js");
    const { prepareMiniappProfileAuthority } =
      await import("../../apps/server/dist/runtime/miniapp-authority-bootstrap.js");
    const bundle = await loadMigrationBundle(resolve("packages/db/src/migrations"));
    const root = await mkdtemp(join(tmpdir(), "laundry-portable-fixture-"));
    const admin = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 1 });
    const owned = [];
    const databases = [];
    const pools = [];
    const scalar = (pool) => async (sql) => {
      const result = await pool.query(sql);
      return result.rows.length === 0 ? "" : String(Object.values(result.rows[0])[0]);
    };
    try {
      for (let index = 0; index < 2; index++) {
        const name = `laundry_restore_${randomUUID().replaceAll("-", "")}`;
        await admin.query(
          `CREATE DATABASE ${name} WITH TEMPLATE template0 OWNER laundry_owner ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
        );
        owned.push(name);
        await admin.query(`COMMENT ON DATABASE ${name} IS '${name}';
          REVOKE CREATE,TEMPORARY ON DATABASE ${name} FROM PUBLIC,laundry_app;
          GRANT CONNECT ON DATABASE ${name} TO laundry_app`);
        const connect = (value) => {
          const url = new URL(value);
          url.pathname = `/${name}`;
          const pool = new Pool({ connectionString: url.href, max: 1 });
          pools.push(pool);
          return pool;
        };
        const owner = connect(process.env.DATABASE_ADMIN_URL);
        const app = connect(process.env.LAUNDRY_PG_APP_URL);
        await applyRuntimeMigrations(owner, bundle);
        databases.push({ name, owner, app });
      }
      const [source, target] = databases;
      await bootstrapLocalIdentity(
        { pool: source.owner, passwordPort: createPasswordPort() },
        {
          profile: LOCAL_PROFILE,
          adminUsername: "portable-admin",
          adminDisplayName: "Synthetic admin",
          adminPassword: randomBytes(32).toString("hex"),
          adminPin: "184729",
          approverUsername: "portable-approver",
          approverDisplayName: "Synthetic approver",
          approverPassword: randomBytes(32).toString("hex"),
          approverPin: "528316",
          demoOnly: false,
        },
      );
      const sourceSql = scalar(source.owner);
      assert.equal(await localRuntimeCommissioningState(source.app, false), "commissioned");
      await assert.rejects(readPortableFixtureNote(sourceSql));
      await assert.rejects(mutatePortableFixtureNote(sourceSql));
      await seedBackupPhotoFixture(sourceSql, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      const original = await readPortableFixtureNote(sourceSql);
      assert.equal(JSON.parse(original).note, null);
      // Reproduce the old harness error against actual startup identity validation.
      await source.owner.query("UPDATE stores SET name='synthetic portable mutation' WHERE id=$1", [
        LOCAL_PROFILE.storeId,
      ]);
      await assert.rejects(localRuntimeCommissioningState(source.app, false), {
        message: "LOCAL_RUNTIME_NOT_READY",
      });
      await source.owner.query("UPDATE stores SET name=$2 WHERE id=$1", [
        LOCAL_PROFILE.storeId,
        LOCAL_PROFILE.storeName,
      ]);
      const path = join(root, "database.ndjson");
      const output = await open(path, "wx", 0o600);
      let inventory;
      try {
        const client = await source.owner.connect();
        try {
          inventory = await exportPortableDatabase(client, output, bundle.aggregateChecksum);
        } finally {
          client.release();
        }
      } finally {
        await output.close();
      }
      await mutatePortableFixtureNote(sourceSql);
      assert.equal(
        JSON.parse(await readPortableFixtureNote(sourceSql)).note,
        "synthetic portable mutation",
      );
      assert.equal(await localRuntimeCommissioningState(source.app, false), "commissioned");
      await verifyRuntimeMigrationLedger(source.owner, bundle);
      const input = await open(path, "r");
      try {
        const client = await target.owner.connect();
        try {
          await importPortableDatabase(
            client,
            input,
            {
              inventory,
              migrations: bundle.aggregateChecksum,
            },
            target.name,
          );
        } finally {
          client.release();
        }
      } finally {
        await input.close();
      }
      await verifyRuntimeMigrationLedger(target.owner, bundle);
      assert.equal(await localRuntimeCommissioningState(target.app, false), "commissioned");
      await prepareMiniappProfileAuthority(target.owner, randomBytes(32).toString("hex"));
      assert.equal(await readPortableFixtureNote(scalar(target.owner)), original);
      assert.equal(await scalar(target.owner)("SELECT name FROM stores"), LOCAL_PROFILE.storeName);
      assert.equal(
        await scalar(target.owner)("SELECT count(*) FROM sessions WHERE status='active'"),
        "0",
      );
    } finally {
      for (const pool of pools) await pool.end();
      for (const name of owned) await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
