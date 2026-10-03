import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { backupFixture } from "./backup-test-fixture.mjs";
import { digest } from "./companion-contract.mjs";
import { databaseTools } from "./backup-database.mjs";
import { schemaMaintenance } from "./upgrade-maintenance.mjs";
import { probeApplication } from "./upgrade-probe.mjs";
import { revokeRestoredAuthority } from "./restore-authority.mjs";
import { readRollbackIdentity } from "./rollback-identity.mjs";

const enabled = process.env.LAUNDRY_USE_LOCAL_PG === "1";
// Only run inside run-pg-fixture.mjs: the container and laundry_v2 database are
// disposable synthetic fixtures, identified by the random published port/name.
test(
  "real PostgreSQL shadow migration, actual application probe and paired rollback preserve both snapshots",
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    const require = createRequire(resolve("apps/server/package.json"));
    const { Pool } = require("pg");
    const execute = promisify(execFile);
    const url = new URL(process.env.DATABASE_ADMIN_URL);
    assert.equal(url.hostname, "127.0.0.1");
    const names = (
      await execute("docker", ["ps", "--filter", "name=^/laundry-v1-pg-", "--format", "{{.Names}}"])
    ).stdout
      .trim()
      .split("\n");
    let container;
    for (const name of names.filter((value) => /^laundry-v1-pg-[a-f0-9]{12}$/u.test(value))) {
      const ports = JSON.parse(
        (await execute("docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", name]))
          .stdout,
      );
      if (
        ports["5432/tcp"]?.some((port) => port.HostIp === "127.0.0.1" && port.HostPort === url.port)
      )
        container = name;
    }
    assert.match(container, /^laundry-v1-pg-[a-f0-9]{12}$/u);
    const connect = async (name, action) => {
      const selected = new URL(url);
      selected.pathname = `/${name}`;
      const pool = new Pool({ connectionString: selected.href, max: 1 });
      try {
        return await action(pool);
      } finally {
        await pool.end();
      }
    };
    const { loadMigrationBundle, applyRuntimeMigrations, verifyRuntimeMigrationLedger } =
      await import("../../apps/server/dist/runtime/migration-bundle.js");
    const { bootstrapLocalIdentity } = await import("../../apps/server/dist/local/bootstrap.js");
    const { LOCAL_PROFILE } = await import("../../apps/server/dist/local/profile.js");
    const currentBundle = await loadMigrationBundle(resolve("packages/db/src/migrations"));
    const name = `${String(currentBundle.entries.length + 1).padStart(4, "0")}_schema_fixture.sql`;
    const sql =
      "CREATE TABLE public.schema_upgrade_fixture(id integer PRIMARY KEY); INSERT INTO public.schema_upgrade_fixture VALUES(1);";
    const entries = [...currentBundle.entries, { filename: name, checksum: digest(sql), sql }];
    const nextBundle = {
      entries,
      head: name,
      aggregateChecksum: digest(
        entries.map((entry) => `${entry.filename}\0${entry.checksum}\n`).join(""),
      ),
    };
    const disabledStaff = randomUUID(),
      removedStaff = randomUUID();
    const sessionId = randomUUID(),
      deviceId = randomUUID(),
      grantId = randomUUID(),
      pendingId = randomUUID(),
      approvalId = randomUUID(),
      policyId = randomUUID();
    await connect("laundry_v2", async (pool) => {
      await pool.query(
        "CREATE TABLE laundry_schema_migrations(filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      for (const entry of currentBundle.entries)
        await pool.query("INSERT INTO laundry_schema_migrations(filename,checksum) VALUES($1,$2)", [
          entry.filename,
          entry.checksum,
        ]);
      await bootstrapLocalIdentity(
        {
          pool,
          passwordPort: {
            hashPassword: async (value) =>
              `$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGlj$${digest(value)}`,
            verifyPassword: async () => false,
          },
        },
        {
          profile: LOCAL_PROFILE,
          adminUsername: "fixture-admin",
          adminDisplayName: "Fixture",
          adminPassword: "synthetic-only-password",
          adminPin: "432165",
          approverUsername: "fixture-approver",
          approverDisplayName: "Approver",
          approverPassword: "synthetic-approver-password",
          approverPin: "987654",
          demoOnly: false,
        },
      );
      await pool.query(
        "CREATE TABLE upgrade_write_fixture(id integer PRIMARY KEY); INSERT INTO upgrade_write_fixture VALUES(1)",
      );
      const { orgId, storeId, adminStaffId } = LOCAL_PROFILE;
      await pool.query(
        "INSERT INTO payment_channel_settings(org_id,store_id,channel,version,enabled,app_id,merchant_id,account_fingerprint,credential_id,envelope_json,updated_by) VALUES($1,$2,'wechat',1,true,'wx0000000000000000','123456',$3,$4,'{}',$5)",
        [orgId, storeId, "a".repeat(64), randomUUID(), adminStaffId],
      );
      await pool.query(
        "INSERT INTO ai_provider_keys(id,org_id,provider_code,credential_version,row_version,status,ciphertext,nonce,auth_tag,wrapped_dek,kms_key_id,kms_key_version,envelope_schema_version,last4,created_by_staff_id,created_at,updated_by_staff_id,updated_at,activated_at) VALUES($1,$2,'fixture',1,1,'active',$3,$4,$5,$6,'fixture','1',1,'test',$7,now(),$7,now(),now())",
        [
          randomUUID(),
          orgId,
          Buffer.alloc(32),
          Buffer.alloc(12),
          Buffer.alloc(16),
          Buffer.alloc(32),
          adminStaffId,
        ],
      );
      await pool.query(
        "INSERT INTO notification_provider_settings(org_id,store_id,version,enabled,provider,sign_name,template_code,unit_cost_cents,max_batch_cost_cents,credential_id,envelope_json,updated_by) VALUES($1,$2,1,true,'aliyun_sms','fixture','SMS_1',1,1,$3,$4,$5)",
        [orgId, storeId, randomUUID(), JSON.stringify({ synthetic: "x".repeat(64) }), adminStaffId],
      );
      for (const id of [disabledStaff, removedStaff]) {
        await pool.query(
          "INSERT INTO staffs(id,org_id,username,password_hash,pin_hash,display_name,created_at,updated_at) SELECT $1,org_id,$2,password_hash,pin_hash,'Fixture',now(),now() FROM staffs WHERE id=$3",
          [id, `fixture-${id}`, adminStaffId],
        );
        await pool.query(
          "INSERT INTO staff_store_roles(id,org_id,store_id,staff_id,role,is_privacy_admin,created_at,updated_at) VALUES($1,$2,$3,$4,'admin',true,now(),now())",
          [randomUUID(), orgId, storeId, id],
        );
      }
      await pool.query(
        "INSERT INTO sessions(id,org_id,store_id,staff_id,device_id,session_version,permission_version,authentication_method,status,created_at) VALUES($1,$2,$3,$4,$5,2,1,'password','active',now())",
        [sessionId, orgId, storeId, adminStaffId, deviceId],
      );
      await pool.query(
        "INSERT INTO remote_assistance_sessions(id,org_id,store_id,actor_id,session_id,session_version,permission_version,approved_at,expires_at,status) VALUES($1,$2,$3,$4,$5,2,1,now(),now()+interval '1 hour','active')",
        [randomUUID(), orgId, storeId, adminStaffId, sessionId],
      );
      await pool.query(
        "INSERT INTO edge_devices(org_id,store_id,device_id,public_key_spki,public_key_fingerprint,paired_by_staff_id,paired_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,now(),now())",
        [orgId, storeId, deviceId, "a".repeat(44), "a".repeat(64), adminStaffId],
      );
      await pool.query(
        "INSERT INTO offline_grants(id,org_id,store_id,staff_id,device_id,request_nonce,permission_version,allowed_commands,protocol_version,signature,issued_at,not_after) VALUES($1,$2,$3,$4,$5,$6,1,'[\"order.create\"]','1.0.0',$7,now(),now()+interval '1 hour')",
        [grantId, orgId, storeId, adminStaffId, deviceId, randomUUID(), "a".repeat(86)],
      );
      await pool.query(
        "INSERT INTO ai_pending_actions(nonce,org_id,store_id,command,command_version,args_json,args_hash,creator_staff_id,idempotency_key,created_at_epoch,expires_at_epoch,status,effective_risk,policy_outcome,requires_other_approver) VALUES($1,$2,$3,'notification.delivery_batch.enqueue','0.1.0','{}',$4,$5,$6,1,9999999999,'pending','R4','step_up',true)",
        [pendingId, orgId, storeId, "a".repeat(64), adminStaffId, randomUUID()],
      );
      const other = (
        await pool.query(
          "SELECT id FROM staffs WHERE org_id=$1 AND id<>$2 AND username='fixture-approver' LIMIT 1",
          [orgId, adminStaffId],
        )
      ).rows[0].id;
      await pool.query(
        "INSERT INTO ai_approval_requests(approval_ref,org_id,store_id,pending_action_ref,command,command_version,args_json,args_hash,entity_versions_json,idempotency_key,requester_staff_id,requester_permission_version,status,row_version,created_at_epoch,expires_at_epoch,decided_by_staff_id,decided_by_permission_version,decided_at_epoch) VALUES($1,$2,$3,$4,'notification.delivery_batch.enqueue','0.1.0','{}',$5,'[]',$6,$7,1,'approved',1,1,9999999999,$8,1,2)",
        [approvalId, orgId, storeId, pendingId, "a".repeat(64), randomUUID(), adminStaffId, other],
      );
      await pool.query(
        "INSERT INTO automation_policies(id,org_id,store_id,name,tool,tool_version,object_filter_json,schedule_json,limits_json,status,row_version,valid_from,approved_by_staff_id,approved_at,next_run_at,created_by_staff_id,created_at,updated_by_staff_id,updated_at) VALUES($1,$2,$3,'fixture','notification.delivery_batch.enqueue','0.1.0',$4,$5,$6,'active',1,now(),$7,now(),now(),$7,now(),$7,now())",
        [
          policyId,
          orgId,
          storeId,
          JSON.stringify({
            min_age_days: 30,
            unpaid_only: false,
            garment_statuses: ["ready"],
            max_objects: 1,
          }),
          JSON.stringify({
            cadence: "daily",
            local_time: "09:00",
            days_of_week: [1],
            window_start_local: "08:00",
            window_end_local: "18:00",
          }),
          JSON.stringify({ max_runs_per_day: 1, max_amount_cents: 100 }),
          adminStaffId,
        ],
      );
    });
    const base = await backupFixture(t);
    const old = {
      ...base.entry,
      migrationHead: currentBundle.head,
      migrations: currentBundle.aggregateChecksum,
    };
    const next = {
      ...old,
      digest: "e".repeat(64),
      migrationHead: nextBundle.head,
      migrations: nextBundle.aggregateChecksum,
    };
    const adminFile = join(base.root, "secrets/database-admin-url"),
      appFile = join(base.root, "secrets/database-url");
    await base.io.write(adminFile, "postgresql://postgres:synthetic@127.0.0.1:8543/laundry_v2");
    await base.io.write(appFile, "postgresql://laundry_app:synthetic@127.0.0.1:8543/laundry_v2");
    const env = { DATABASE_ADMIN_URL_FILE: adminFile, DATABASE_URL_FILE: appFile };
    let state = {
      schema: 1,
      assurance: "development_only",
      phase: "running",
      current: old,
      previous: null,
      controller: old,
      pending: null,
      releases: [old, next],
    };
    const lifecycle = {
      ...base,
      getState: () => state,
      stop: async () => {},
      start: async () => {
        state = { ...state, phase: "running" };
      },
      saveState: async (value) => {
        state = value;
      },
    };
    const bundleFor = (entry) => (entry.digest === old.digest ? currentBundle : nextBundle);
    const context = async (_lifecycle, entry) => ({
      ...base,
      entry,
      payload: entry.digest,
      env,
      manifest: {
        sources: { postgres: { version: base.postgresVersion } },
        files: bundleFor(entry).entries.map((item) => ({
          path: `migrations/${item.filename}`,
          size: Buffer.byteLength(item.sql),
          sha256: item.checksum,
        })),
      },
    });
    const native = (ctx) =>
      databaseTools(ctx, {
        run: async (_file, args) =>
          connect(args.find((arg) => arg.startsWith("--dbname=")).slice(9), async (pool) => {
            const result = await pool.query(args.at(-1));
            const rows = (Array.isArray(result) ? result.at(-1) : result).rows;
            return rows
              .map((row) =>
                Object.values(row)
                  .map((value) =>
                    value === null
                      ? ""
                      : typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value),
                  )
                  .join("|"),
              )
              .join("\n");
          }),
        kit: async (_payload, _action, selected) => {
          const name = new URL(await base.io.read(selected.DATABASE_ADMIN_URL_FILE)).pathname.slice(
            1,
          );
          await connect(name, (pool) => verifyRuntimeMigrationLedger(pool, bundleFor(ctx.entry)));
        },
        stream: async (file, args, _env, _root, streams) => {
          const database = args.find((arg) => arg.startsWith("--dbname="));
          const program = file.endsWith("pg_dump.exe") ? "pg_dump" : "pg_restore";
          const child = execFile(
            "docker",
            [
              "exec",
              "-i",
              container,
              program,
              "--username=postgres",
              database,
              "--format=custom",
              ...(program === "pg_restore" ? ["--single-transaction", "--exit-on-error"] : []),
            ],
            { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
          );
          const result = new Promise((resolveResult, reject) => {
            const chunks = [];
            child.stdout.on("data", (chunk) => chunks.push(chunk));
            let stderr = "";
            child.stderr.on("data", (chunk) => {
              stderr += chunk;
            });
            child.on("error", reject);
            child.on("close", (code) =>
              code === 0 ? resolveResult(Buffer.concat(chunks)) : reject(new Error(stderr)),
            );
          });
          child.stdin.end(streams.input ? await streams.input.readFile() : undefined);
          const bytes = await result;
          if (streams.output) await streams.output.writeFile(bytes);
        },
      });
    const [runtimeModule, appModule, configModule, cookieModule] = await Promise.all([
      import("../../apps/server/dist/http/http-runtime.js"),
      import("../../apps/server/dist/http/create-app.js"),
      import("../../apps/server/dist/local/config.js"),
      import("../../apps/server/dist/http/cookie-policy.js"),
    ]);
    const dependencies = {
      context,
      database: native,
      backupSpace: async () => {},
      pgControl: async () => {},
      migrate: async (_ctx, name) =>
        connect(name, (pool) => applyRuntimeMigrations(pool, nextBundle)),
      resetAuthority: async (_ctx, name) => {
        const identity = await connect("laundry_v2", readRollbackIdentity);
        return connect(name, async (pool) => {
          const client = await pool.connect();
          try {
            await revokeRestoredAuthority(client, name, identity);
          } finally {
            client.release();
          }
        });
      },
      probe: async (_ctx, name) => {
        const appUrl = new URL(process.env.LAUNDRY_PG_APP_URL);
        appUrl.pathname = `/${name}`;
        await probeApplication(
          {
            createRuntime: runtimeModule.createHttpRuntime,
            createApp: appModule.createLocalApp,
            parseConfig: configModule.parseLocalHostConfig,
            cookiePolicy: cookieModule.resolveCookiePolicy,
            aiOptions: async () => ({}),
          },
          {
            DATABASE_URL: appUrl.href,
            LAUNDRY_ACCESS_TOKEN_SECRET: "a".repeat(64),
            LAUNDRY_CSRF_PROOF_SECRET: "b".repeat(64),
            LAUNDRY_NOTIFICATION_PROVIDER_MODE: "disabled",
          },
        );
      },
    };
    await schemaMaintenance("upgrade", next, lifecycle, dependencies);
    assert.equal(state.current.digest, next.digest);
    await connect("laundry_v2", async (pool) => {
      assert.equal(
        (await pool.query("SELECT status FROM sessions WHERE id=$1", [sessionId])).rows[0].status,
        "active",
      );
      assert.equal(
        (await pool.query("SELECT status FROM ai_provider_keys")).rows[0].status,
        "active",
      );
      assert.equal(
        (await pool.query("SELECT enabled FROM payment_channel_settings")).rows[0].enabled,
        true,
      );
      assert.equal(
        (await pool.query("SELECT enabled FROM notification_provider_settings")).rows[0].enabled,
        true,
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM schema_upgrade_fixture")).rows[0].n,
        1,
      );
      await pool.query("INSERT INTO upgrade_write_fixture VALUES(2)");
      await pool.query(
        "UPDATE staffs SET password_hash=$2,pin_hash=$3,permission_version=permission_version+2 WHERE id=$1",
        [LOCAL_PROFILE.adminStaffId, "changed-password-hash", "changed-pin-hash"],
      );
      await pool.query("UPDATE staffs SET is_active=false WHERE id=$1", [disabledStaff]);
      await pool.query("DELETE FROM staff_store_roles WHERE staff_id=ANY($1::uuid[])", [
        [disabledStaff, removedStaff],
      ]);
      await pool.query("DELETE FROM staffs WHERE id=$1", [removedStaff]);
    });
    await schemaMaintenance("rollback", old, lifecycle, dependencies);
    assert.equal(state.current.digest, old.digest);
    await connect("laundry_v2", async (pool) => {
      assert.equal(
        (await pool.query("SELECT to_regclass('schema_upgrade_fixture') IS NULL AS absent")).rows[0]
          .absent,
        true,
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM upgrade_write_fixture")).rows[0].n,
        1,
      );
      assert.equal(
        (await pool.query("SELECT status FROM sessions WHERE id=$1", [sessionId])).rows[0].status,
        "revoked",
      );
      assert.equal(
        (await pool.query("SELECT status FROM ai_provider_keys")).rows[0].status,
        "revoked",
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM payment_channel_settings")).rows[0].n,
        0,
      );
      assert.equal(
        (await pool.query("SELECT status FROM remote_assistance_sessions")).rows[0].status,
        "revoked",
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM notification_provider_settings")).rows[0]
          .n,
        0,
      );
      const identity = (
        await pool.query(
          "SELECT password_hash,pin_hash,permission_version FROM staffs WHERE id=$1",
          [LOCAL_PROFILE.adminStaffId],
        )
      ).rows[0];
      assert.equal(identity.password_hash, "changed-password-hash");
      assert.equal(identity.pin_hash, "changed-pin-hash");
      assert.ok(identity.permission_version > 3);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM staffs WHERE id=ANY($1::uuid[]) AND is_active",
            [[disabledStaff, removedStaff]],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM staff_store_roles WHERE staff_id=ANY($1::uuid[]) AND is_active",
            [[disabledStaff, removedStaff]],
          )
        ).rows[0].n,
        0,
      );
      assert.notEqual(
        (await pool.query("SELECT revoked_at FROM offline_grants WHERE id=$1", [grantId])).rows[0]
          .revoked_at,
        null,
      );
      assert.equal(
        (await pool.query("SELECT status FROM ai_pending_actions WHERE nonce=$1", [pendingId]))
          .rows[0].status,
        "expired",
      );
      assert.equal(
        (
          await pool.query("SELECT status FROM ai_approval_requests WHERE approval_ref=$1", [
            approvalId,
          ])
        ).rows[0].status,
        "expired",
      );
      assert.equal(
        (await pool.query("SELECT status FROM automation_policies WHERE id=$1", [policyId])).rows[0]
          .status,
        "paused",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM audit_log WHERE command='runtime.restore.revoke_authority' AND org_id=$1 AND store_id=$2",
            [LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId],
          )
        ).rows[0].n,
        1,
      );
    });
    const history = JSON.parse(await readFile(join(base.root, "upgrade-history.json")));
    assert.equal(history.length, 2);
    assert.equal(new Set(history.flatMap((entry) => [entry.before.id, entry.after.id])).size, 4);
  },
);
