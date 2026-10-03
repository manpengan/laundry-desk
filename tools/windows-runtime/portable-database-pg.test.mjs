import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { exportPortableDatabase, importPortableDatabase } from "./portable-database.mjs";

const require = createRequire(resolve("apps/server/package.json"));
const { Client } = require("pg");
const enabled = process.env.LAUNDRY_USE_LOCAL_PG === "1";
const digest = (value) => createHash("sha256").update(value).digest("hex");

// Run only inside tools/data-transfer/run-pg-fixture.mjs. Every write targets a
// newly created random database, never the URL's existing application database.
test(
  "all current migrations round-trip through bound shadows with constraints active",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "laundry-portable-pg-"));
    const names = [0, 1].map(() => `laundry_restore_${randomUUID().replaceAll("-", "")}`);
    const admin = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
    const clients = [];
    const files = [];
    const migrationRoot = resolve("packages/db/src/migrations");
    for (const name of (await readdir(migrationRoot))
      .filter((f) => /^\d{4}_.*\.sql$/u.test(f))
      .sort())
      files.push({ name, sql: await readFile(join(migrationRoot, name), "utf8") });
    const migrations = digest(files.map((f) => `${f.name}\0${digest(f.sql)}\n`).join(""));
    await admin.connect();
    try {
      for (const name of names) {
        await admin.query(`CREATE DATABASE ${name} WITH TEMPLATE template0 OWNER laundry_owner`);
        await admin.query(`COMMENT ON DATABASE ${name} IS '${name}'`);
        const url = new URL(process.env.DATABASE_ADMIN_URL);
        url.pathname = `/${name}`;
        const client = new Client({ connectionString: url.href });
        await client.connect();
        clients.push(client);
        await client.query("GRANT ALL ON SCHEMA public TO laundry_owner");
        await client.query(
          "CREATE TABLE laundry_schema_migrations(filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
        );
        for (const file of files) {
          if (file.name !== "0001_roles.sql")
            await client.query(`BEGIN; SET LOCAL ROLE laundry_owner; ${file.sql}\nCOMMIT;`);
          await client.query(
            "INSERT INTO laundry_schema_migrations(filename,checksum) VALUES($1,$2)",
            [file.name, digest(file.sql)],
          );
        }
        await client.query(
          "CREATE TABLE portable_fixture(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, parent_id bigint REFERENCES portable_fixture(id), content text, bytes bytea, exact bigint)",
        );
        await client.query("INSERT INTO portable_fixture(content) VALUES('target-seed')");
      }
      const [source, target] = clients;
      const org = randomUUID(),
        store = randomUUID(),
        staff = randomUUID(),
        session = randomUUID(),
        device = randomUUID();
      await source.query(
        "INSERT INTO orgs(id,code,name,created_at,updated_at) VALUES($1,$2,'Portable fixture',now(),now())",
        [org, `portable-${org}`],
      );
      await source.query(
        "INSERT INTO stores(id,org_id,code,name,created_at,updated_at) VALUES($1,$2,'main','Fixture',now(),now())",
        [store, org],
      );
      await source.query(
        "INSERT INTO staffs(id,org_id,username,password_hash,display_name,created_at,updated_at) VALUES($1,$2,'owner','synthetic-only','Owner',now(),now())",
        [staff, org],
      );
      await source.query(
        "INSERT INTO sessions(id,org_id,store_id,staff_id,device_id,session_version,permission_version,authentication_method,status,created_at) VALUES($1,$2,$3,$4,$5,7,1,'password','active',now())",
        [session, org, store, staff, device],
      );
      await source.query(
        "INSERT INTO edge_devices(org_id,store_id,device_id,public_key_spki,public_key_fingerprint,paired_by_staff_id,paired_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,now(),now())",
        [org, store, device, "a".repeat(44), "a".repeat(64), staff],
      );
      const pendingExport = randomUUID(),
        completedExport = randomUUID();
      for (const id of [pendingExport, completedExport])
        await source.query(
          "INSERT INTO store_export_requests(id,org_id,store_id,actor_id,session_id,session_version,permission_version,policy_sha256,approved_at,expires_at,consumed_at,manifest_sha256,approval_signature) VALUES($1,$2,$3,$4,$5,7,1,$6,now(),now()+interval '10 minutes',CASE WHEN $7 THEN now() ELSE NULL END,CASE WHEN $7 THEN $6 ELSE NULL END,$8)",
          [
            id,
            org,
            store,
            staff,
            session,
            "d".repeat(64),
            id === completedExport,
            `${"A".repeat(86)}==`,
          ],
        );
      await source.query(
        "INSERT INTO notification_provider_settings(org_id,store_id,version,enabled,provider,sign_name,template_code,unit_cost_cents,max_batch_cost_cents,credential_id,envelope_json,updated_by) VALUES($1,$2,1,true,'aliyun_sms','Fixture','SMS_1',1,100,$3,$4,$5)",
        [
          org,
          store,
          randomUUID(),
          JSON.stringify({ sealed: "must-not-be-exported-".repeat(5) }),
          staff,
        ],
      );
      const injected = "中文'); DROP TABLE orgs; --\n\\.\nCOPY sneaky FROM PROGRAM 'evil';";
      await source.query(
        "INSERT INTO portable_fixture(parent_id,content,bytes,exact) VALUES(1,$1,$2,$3)",
        [injected, Buffer.from([0, 1, 255]), "9223372036854775806"],
      );
      await source.query("SELECT setval('portable_fixture_id_seq', 9999, true)");
      const path = join(root, "database.ndjson");
      const output = await open(path, "wx", 0o600);
      let inventory;
      try {
        inventory = await exportPortableDatabase(source, output, migrations);
      } finally {
        await output.close();
      }
      assert.equal(inventory.counts.notification_provider_settings, 0);
      assert.equal(inventory.counts.ai_provider_keys, 0);
      assert.equal((await readFile(path, "utf8")).includes("must-not-be-exported"), false);
      const input = await open(path, "r");
      const expected = { inventory, migrations };
      try {
        await assert.rejects(
          importPortableDatabase(source, input, expected, "laundry_v2"),
          /PORTABLE_SHADOW_REQUIRED/,
        );
        await target.query(`COMMENT ON DATABASE ${names[1]} IS 'unbound'`);
        await assert.rejects(
          importPortableDatabase(target, input, expected, names[1]),
          /PORTABLE_SHADOW_REQUIRED/,
        );
        await target.query(`COMMENT ON DATABASE ${names[1]} IS '${names[1]}'`);
        await assert.rejects(
          importPortableDatabase(
            target,
            input,
            { ...expected, inventory: { ...inventory, sha256: "0".repeat(64) } },
            names[1],
          ),
          /PORTABLE_DATABASE_HASH_MISMATCH/,
        );
        assert.equal(
          (await target.query("SELECT count(*)::int AS count FROM portable_fixture")).rows[0].count,
          1,
        );
        await importPortableDatabase(target, input, expected, names[1]);
      } finally {
        await input.close();
      }
      const row = (
        await target.query(
          "SELECT content,bytes,exact::text FROM portable_fixture WHERE parent_id=1",
        )
      ).rows[0];
      assert.equal(row.content, injected);
      assert.deepEqual(row.bytes, Buffer.from([0, 1, 255]));
      assert.equal(row.exact, "9223372036854775806");
      assert.equal(
        (await target.query("SELECT nextval('portable_fixture_id_seq')::text AS n")).rows[0].n,
        "10000",
      );
      assert.equal((await target.query("SELECT status FROM sessions")).rows[0].status, "revoked");
      const pendingReceipt = (
        await target.query(
          "SELECT revoked_at,consumed_at,manifest_sha256 FROM store_export_requests WHERE id=$1",
          [pendingExport],
        )
      ).rows[0];
      assert.ok(pendingReceipt.revoked_at);
      assert.equal(pendingReceipt.consumed_at, null);
      assert.equal(pendingReceipt.manifest_sha256, null);
      const completedReceipt = (
        await target.query(
          "SELECT revoked_at,consumed_at,manifest_sha256 FROM store_export_requests WHERE id=$1",
          [completedExport],
        )
      ).rows[0];
      assert.equal(completedReceipt.revoked_at, null);
      assert.ok(completedReceipt.consumed_at);
      assert.equal(completedReceipt.manifest_sha256, "d".repeat(64));
      assert.equal(
        (await target.query("SELECT session_version FROM sessions")).rows[0].session_version,
        8,
      );
      assert.equal(
        (await target.query("SELECT status FROM edge_devices")).rows[0].status,
        "revoked",
      );
      assert.equal(
        (await target.query("SELECT count(*)::int AS count FROM notification_provider_settings"))
          .rows[0].count,
        0,
      );
      assert.equal(
        (
          await target.query(
            "SELECT count(*)::int AS count FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='D'",
          )
        ).rows[0].count,
        0,
      );
      await assert.rejects(target.query("INSERT INTO portable_fixture(parent_id) VALUES(999999)"), {
        code: "23503",
      });
      process.stdout.write(
        `Portable roundtrip: ${inventory.schema.length} tables, ${files.length} migrations.\n`,
      );
    } finally {
      for (const client of clients) await client.end();
      for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
