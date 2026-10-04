import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { backupFixture } from "./backup-test-fixture.mjs";
import { readMaintenance } from "./backup-files.mjs";
import { schemaMaintenance, upgradeHistory } from "./upgrade-maintenance.mjs";
import { requireMigrationExtension } from "./upgrade-contract.mjs";
import { probeApplication } from "./upgrade-probe.mjs";

async function fixture(t, failure = "", writeFault = "") {
  const base = await backupFixture(t),
    events = [];
  const old = base.entry,
    next = {
      ...old,
      digest: "d".repeat(64),
      source: "e".repeat(40),
      migrations: "f".repeat(64),
      migrationHead: "0070_next.sql",
      release: "0.2.0-win-dev",
    };
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
  const original = { schema: old.migrations, orders: 2 },
    databases = new Map([[1, original]]);
  let current = 1,
    shadow = null,
    previous = null,
    running = true,
    armed = true;
  const fault = (step) => {
    events.push(step);
    if (armed && step === failure) {
      armed = false;
      throw new Error(`INJECTED_${step}`);
    }
  };
  const item = { path: "migrations/0069_bounded_automation.sql", size: 1, sha256: "a".repeat(64) };
  const contexts = new Map(
    [old, next].map((entry) => [
      entry.digest,
      {
        ...base,
        entry,
        payload: entry.digest,
        env: {},
        manifest: {
          sources: { postgres: { version: "16.15" } },
          files: entry === old ? [item] : [item, { ...item, path: "migrations/0070_next.sql" }],
        },
      },
    ]),
  );
  const lifecycle = {
    ...base,
    getState: () => state,
    stopRaw: async () => {
      running = false;
      fault("stop");
    },
    stop: async () => {
      running = false;
      fault("stop");
    },
    start: async (entry) => {
      assert.equal(await readMaintenance(base.io, base.root), null);
      assert.equal(databases.get(current).schema, entry.migrations);
      running = true;
      state = { ...state, phase: "running" };
      fault("start");
    },
    saveState: async (value) => {
      state = value;
      fault("state");
    },
    io: {
      ...base.io,
      write: async (path, value) => {
        await base.io.write(path, value);
        if (
          armed &&
          writeFault &&
          path.endsWith("maintenance.json") &&
          JSON.parse(value).phase === writeFault
        ) {
          armed = false;
          throw new Error("INJECTED_write_ack");
        }
      },
    },
  };
  const dependencies = {
    context: async (_lifecycle, entry) => contexts.get(entry.digest),
    backupSpace: async () => {},
    pgControl: async (verb, _root, payload) =>
      fault(`pg-${verb}-${payload === old.digest ? "old" : "new"}`),
    restorePhotos: async () => fault("photos"),
    probe: async () => fault("probe"),
    resetAuthority: async () => fault("reset-authority"),
    migrate: async () => {
      databases.set(shadow, { ...databases.get(shadow), schema: next.migrations });
      fault("migrate");
    },
    database: (context) => ({
      verify: async (name) => {
        assert.equal(databases.get(name ? shadow : current).schema, context.entry.migrations);
        fault("verify");
      },
      space: async () => {},
      dump: async (file) => file.writeFile(JSON.stringify(databases.get(current))),
      candidate: async () => ({
        name: `laundry_restore_${"a".repeat(32)}`,
        previous: `laundry_previous_${"a".repeat(32)}`,
        original_oid: current,
        restored_oid: null,
      }),
      create: async (value) => {
        shadow = current === 1 ? 2 : 1;
        databases.set(shadow, {});
        fault("create");
        return { ...value, restored_oid: shadow };
      },
      restore: async (_value, backup) => {
        databases.set(shadow, JSON.parse(await readFile(backup.path, "utf8")));
        fault("restore");
      },
      swap: async () => {
        previous = current;
        current = shadow;
        shadow = null;
        fault("swap");
      },
      finish: async () => {
        fault("finish");
        if (previous !== null) databases.delete(previous);
        previous = null;
      },
      recover: async () => {
        if (previous !== null) {
          shadow = current;
          current = previous;
          previous = null;
        }
        if (shadow !== null) databases.delete(shadow);
        shadow = null;
        fault("recover");
      },
    }),
  };
  return {
    base,
    old,
    next,
    lifecycle,
    dependencies,
    events,
    run: (action = "upgrade", target = next) =>
      schemaMaintenance(action, target, lifecycle, dependencies),
    snapshot: () => ({ current, running, state, data: databases.get(current) }),
    change: (orders) => databases.set(current, { ...databases.get(current), orders }),
  };
}
test("cross-schema upgrade migrates and probes a shadow before atomic data/program selection", async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.schema_transition, "upgrade");
  assert.equal(f.snapshot().state.current.digest, f.next.digest);
  assert.equal(f.snapshot().data.schema, f.next.migrations);
  assert.equal(f.snapshot().data.orders, 2);
  assert.equal(f.events.includes("reset-authority"), false);
  assert.ok(f.events.indexOf("probe") < f.events.indexOf("swap"));
  assert.equal((await upgradeHistory(f.base)).length, 1);
  assert.equal(await readMaintenance(f.base.io, f.base.root), null);
});
for (const failure of ["create", "restore", "migrate", "probe", "swap", "state"])
  test(`interruption at ${failure} restores the matching original program and database`, async (t) => {
    const f = await fixture(t, failure);
    await assert.rejects(f.run(), /INJECTED/);
    assert.equal(f.snapshot().running, false);
    const result = await f.run("maintenance-recover");
    assert.equal(result.committed, false);
    assert.equal(f.snapshot().state.current.digest, f.old.digest);
    assert.deepEqual(f.snapshot().data, { schema: f.old.migrations, orders: 2 });
    assert.equal(f.snapshot().running, true);
  });
test("a lost verified acknowledgement completes the committed pair instead of reverting only code", async (t) => {
  const f = await fixture(t, "", "verified");
  await assert.rejects(f.run(), /INJECTED/);
  const result = await f.run("maintenance-recover");
  assert.equal(result.committed, true);
  assert.equal(f.snapshot().state.current.digest, f.next.digest);
  assert.equal(f.snapshot().data.schema, f.next.migrations);
});
test("schema rollback uses the upgrade's exact pre-upgrade snapshot and retains newer writes in safety history", async (t) => {
  const f = await fixture(t);
  await f.run();
  f.change(7);
  await f.run("rollback", f.old);
  assert.equal(f.snapshot().state.current.digest, f.old.digest);
  assert.deepEqual(f.snapshot().data, { schema: f.old.migrations, orders: 2 });
  assert.equal(f.events.includes("reset-authority"), true);
  const reverse = (await upgradeHistory(f.base)).at(-1);
  const snapshot = JSON.parse(
    await readFile(join(f.base.root, "backups", reverse.before.id, "database.dump"), "utf8"),
  );
  assert.equal(snapshot.orders, 7);
  assert.equal(snapshot.schema, f.next.migrations);
});
test("migration extension rejects changed history and PostgreSQL versions", () => {
  const old = {
    sources: { postgres: { version: "16.15" } },
    files: [{ path: "migrations/0001_initial.sql", sha256: "a", size: 1 }],
  };
  assert.throws(() => requireMigrationExtension(old, old), /MIGRATION_HISTORY_CHANGED/);
  assert.throws(
    () => requireMigrationExtension(old, { ...old, sources: { postgres: { version: "16.16" } } }),
    /POSTGRES_VERSION_INVALID/,
  );
  assert.throws(
    () =>
      requireMigrationExtension(old, {
        ...old,
        files: [{ ...old.files[0], sha256: "bad" }, { path: "migrations/0002_next.sql" }],
      }),
    /MIGRATION_HISTORY_CHANGED/,
  );
});
test("failed rollback authority reset preserves the active new release for explicit recovery", async (t) => {
  const f = await fixture(t, "reset-authority");
  await f.run();
  f.change(7);
  await assert.rejects(f.run("rollback", f.old), /INJECTED_reset-authority/);
  await f.run("maintenance-recover");
  assert.equal(f.snapshot().state.current.digest, f.next.digest);
  assert.equal(f.snapshot().data.orders, 7);
});
test("the actual-program probe never listens or starts workers and always closes its pool", async () => {
  const events = [];
  const modules = {
    createRuntime: async () => ({
      print: { worker: { start: () => assert.fail(), stop: async () => events.push("stop") } },
      pool: { end: async () => events.push("pool") },
    }),
    parseConfig: () => ({}),
    cookiePolicy: () => ({}),
    aiOptions: async () => ({}),
    createApp: async () => ({
      listen: () => assert.fail(),
      ready: async () => {},
      inject: async () => ({ statusCode: 200, json: () => ({ data: { status: "ready" } }) }),
      close: async () => events.push("close"),
    }),
  };
  await probeApplication(modules, {});
  assert.deepEqual(events.sort(), ["close", "pool", "stop"]);
});
