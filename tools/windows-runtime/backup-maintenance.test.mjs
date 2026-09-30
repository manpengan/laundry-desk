import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { backupFixture, release } from "./backup-test-fixture.mjs";
import { backupMaintenance } from "./backup-maintenance.mjs";
import { createBackup, readMaintenance } from "./backup-files.mjs";
import { BACKUP_FILES } from "./companion-contract.mjs";

async function fixture(
  t,
  { failure, commitFailure, wasRunning = true, legacyController = false, afterSwap } = {},
) {
  const context = await backupFixture(t);
  const baseline = { orders: 1, cents: 101 };
  const original = { orders: 2, cents: 202 };
  const target = await createBackup(context, (file) => file.writeFile(JSON.stringify(baseline)));
  const events = [];
  const databases = new Map([[1, original]]);
  let current = 1;
  let running = wasRunning;
  let postgres = wasRunning;
  let armed = true;
  let state = {
    phase: wasRunning ? "running" : "stopped",
    current: release,
    controller: legacyController ? { ...release, digest: "f".repeat(64) } : release,
    pending: null,
  };
  const fault = (point) => {
    if (armed && point === failure) {
      armed = false;
      throw new Error(`INJECTED_${point}`);
    }
  };
  const io = {
    ...context.io,
    write: async (path, value) => {
      const data = path.endsWith("maintenance.json") ? JSON.parse(value) : null;
      if (
        armed &&
        commitFailure &&
        data?.phase === commitFailure.phase &&
        commitFailure.position === "before"
      ) {
        armed = false;
        throw new Error("INJECTED_PERSISTENCE");
      }
      await context.io.write(path, value);
      if (
        armed &&
        commitFailure &&
        data?.phase === commitFailure.phase &&
        commitFailure.position === "after"
      ) {
        armed = false;
        throw new Error("INJECTED_PERSISTENCE");
      }
    },
  };
  const database = {
    space: async () => {},
    verify: async () => {
      events.push("verify");
      fault("verify");
    },
    dump: async (file) => {
      assert.equal(running, false, "dump must run after writers stop");
      events.push("dump");
      fault("dump");
      await file.writeFile(JSON.stringify(databases.get(current)));
    },
    candidate: async () => ({
      name: "laundry_restore_" + "d".repeat(32),
      previous: "laundry_previous_" + "d".repeat(32),
      original_oid: 1,
      restored_oid: null,
    }),
    create: async (candidate) => {
      databases.set(2, {});
      events.push("create");
      fault("create");
      return { ...candidate, restored_oid: 2 };
    },
    restore: async (_candidate, backup) => {
      databases.set(2, JSON.parse(await readFile(backup.path, "utf8")));
      events.push("restore");
      fault("restore");
    },
    swap: async () => {
      assert.equal(running, false);
      current = 2;
      events.push("swap");
      if (afterSwap) await afterSwap(context);
      fault("swap");
    },
    finish: async () => {
      assert.equal(current, 2);
      events.push("finish");
      fault("finish");
      databases.delete(1);
      fault("cleanup");
    },
    recover: async () => {
      current = 1;
      databases.delete(2);
      events.push("recover");
      return { retained_shadow: false };
    },
  };
  const lifecycle = {
    ...context,
    io,
    verify: async (entry) => ({
      payload: "payload",
      manifest: {
        sources: { postgres: { version: "16.15" } },
        files: entry.digest === release.digest ? BACKUP_FILES.map((path) => ({ path })) : [],
      },
    }),
    getState: () => state,
    stop: async () => {
      running = false;
      postgres = false;
      state = { ...state, phase: "stopped" };
      events.push("stop");
    },
    start: async () => {
      assert.equal(
        await readMaintenance(context.io, context.root),
        null,
        "startup cannot bypass maintenance",
      );
      running = true;
      postgres = true;
      state = { ...state, phase: "running" };
      events.push("start");
    },
  };
  const dependencies = {
    database,
    runtimeEnvironment: async () => ({}),
    pgControl: async (action) => {
      postgres = action === "start";
      events.push(`postgres-${action}`);
      if (action === "stop") fault("postgres-stop");
    },
  };
  return {
    context,
    target,
    events,
    baseline,
    original,
    run: (action = "restore", options = { backupId: target.id, confirmation: target.digest }) =>
      backupMaintenance(action, options, lifecycle, dependencies),
    snapshot: () => ({ data: databases.get(current), current, running, postgres, state }),
  };
}

test("restore creates a verified safety backup before replacing data and respects a stopped runtime", async (t) => {
  const subject = await fixture(t, { wasRunning: false });
  const result = await subject.run();
  assert.equal(result.status, "stopped");
  assert.deepEqual(subject.snapshot().data, subject.baseline);
  assert.equal(subject.snapshot().postgres, false);
  assert.ok(subject.events.indexOf("dump") < subject.events.indexOf("create"));
  assert.ok(subject.events.indexOf("restore") < subject.events.indexOf("swap"));
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(subject.context.root, "backups", result.safety_backup.id, "database.dump"),
        "utf8",
      ),
    ),
    subject.original,
  );
  assert.equal(await readMaintenance(subject.context.io, subject.context.root), null);
});

test("wrong confirmation refuses before stopping or creating any recovery point", async (t) => {
  const subject = await fixture(t);
  await assert.rejects(
    subject.run("restore", { backupId: subject.target.id, confirmation: "f".repeat(64) }),
    /CONFIRMATION_MISMATCH/u,
  );
  assert.deepEqual(subject.events, []);
  assert.equal(subject.snapshot().running, true);
});

test("a legacy login controller cannot bypass the recovery gate through a new maintenance caller", async (t) => {
  const subject = await fixture(t, { legacyController: true });
  await assert.rejects(subject.run("backup", {}), /BACKUP_CONTROLLER_UPGRADE_REQUIRED/u);
  assert.deepEqual(subject.events, []);
  assert.equal(subject.snapshot().running, true);
  assert.equal(await readMaintenance(subject.context.io, subject.context.root), null);
});

test("a damaged safety point prevents data commitment and retains the original database for recovery", async (t) => {
  const subject = await fixture(t, {
    afterSwap: async (context) => {
      const journal = await readMaintenance(context.io, context.root);
      await context.io.write(
        join(context.root, "backups", journal.safety.id, "database.dump"),
        "corrupt safety point",
      );
    },
  });
  await assert.rejects(subject.run(), /BACKUP_DUMP_MISMATCH/u);
  assert.equal(
    (await readMaintenance(subject.context.io, subject.context.root)).phase,
    "switching",
  );
  assert.equal(subject.events.includes("finish"), false);
  await subject.run("maintenance-recover", {});
  assert.deepEqual(subject.snapshot().data, subject.original);
});

for (const position of ["before", "after"]) {
  test(`initial maintenance record failure ${position} publication stops writers without changing data`, async (t) => {
    const subject = await fixture(t, { commitFailure: { phase: "quiescing", position } });
    await assert.rejects(subject.run(), /INJECTED_PERSISTENCE/u);
    assert.equal(subject.snapshot().running, false);
    assert.deepEqual(subject.snapshot().data, subject.original);
    const journal = await readMaintenance(subject.context.io, subject.context.root);
    if (position === "before") assert.equal(journal, null);
    else {
      assert.equal(journal.phase, "quiescing");
      await subject.run("maintenance-recover", {});
      assert.equal(subject.snapshot().running, true);
    }
  });
}

for (const failure of ["verify", "dump", "create", "restore", "swap"]) {
  test(`failure at ${failure} stays stopped and explicit recovery restores the original data`, async (t) => {
    const subject = await fixture(t, { failure });
    await assert.rejects(subject.run(), /INJECTED/u);
    assert.equal(subject.snapshot().running, false);
    assert.equal(subject.snapshot().postgres, false);
    assert.ok(await readMaintenance(subject.context.io, subject.context.root));
    await assert.rejects(subject.run(), /MAINTENANCE_RECOVERY_REQUIRED/u);
    const recovered = await subject.run("maintenance-recover", {});
    assert.equal(recovered.recovered, true);
    assert.deepEqual(subject.snapshot().data, subject.original);
    assert.equal(subject.snapshot().running, true);
    assert.deepEqual(
      await readFile(subject.target.path),
      Buffer.from(JSON.stringify(subject.baseline)),
    );
  });
}

for (const failure of ["finish", "cleanup", "postgres-stop"]) {
  test(`interruption after verification at ${failure} finishes the committed restore`, async (t) => {
    const subject = await fixture(t, { failure });
    await assert.rejects(subject.run(), /INJECTED/u);
    assert.equal(
      (await readMaintenance(subject.context.io, subject.context.root)).phase,
      "verified",
    );
    const result = await subject.run("maintenance-recover", {});
    assert.equal(result.committed, true);
    assert.deepEqual(subject.snapshot().data, subject.baseline);
    assert.equal(subject.snapshot().running, true);
  });
}

for (const position of ["before", "after"]) {
  test(`verification record write fails ${position} durable replacement without losing a recovery route`, async (t) => {
    const subject = await fixture(t, { commitFailure: { phase: "verified", position } });
    await assert.rejects(subject.run(), /INJECTED_PERSISTENCE/u);
    const journal = await readMaintenance(subject.context.io, subject.context.root);
    assert.equal(journal.phase, position === "before" ? "switching" : "verified");
    await subject.run("maintenance-recover", {});
    assert.deepEqual(
      subject.snapshot().data,
      position === "before" ? subject.original : subject.baseline,
    );
  });
}

test("backup interruption can recover service without applying or deleting any dump", async (t) => {
  const subject = await fixture(t, { failure: "dump" });
  await assert.rejects(subject.run("backup", {}), /INJECTED/u);
  const journal = await readMaintenance(subject.context.io, subject.context.root);
  assert.equal(journal.operation, "backup");
  await subject.run("maintenance-recover", {});
  assert.deepEqual(subject.snapshot().data, subject.original);
  assert.equal(subject.snapshot().running, true);
});

test("a backup quiesces writes and resumes only after its maintenance record is idle", async (t) => {
  const subject = await fixture(t);
  const result = await subject.run("backup", {});
  assert.equal(result.status, "running");
  assert.deepEqual(subject.snapshot().data, subject.original);
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(subject.context.root, "backups", result.backup_id, "database.dump"),
        "utf8",
      ),
    ),
    subject.original,
  );
  assert.equal(subject.events.includes("swap"), false);
});
