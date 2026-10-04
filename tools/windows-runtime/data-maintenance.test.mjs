import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { backupFixture } from "./backup-test-fixture.mjs";
import { dataMaintenance } from "./data-maintenance.mjs";
import { readMaintenance } from "./backup-files.mjs";

async function fixture(t, failing = "") {
  const context = await backupFixture(t),
    events = [];
  let state = {
    phase: "running",
    current: context.entry,
    controller: context.entry,
    pending: null,
  };
  const candidate = {
    name: `laundry_restore_${"a".repeat(32)}`,
    previous: `laundry_previous_${"a".repeat(32)}`,
    original_oid: 1,
    restored_oid: null,
  };
  const step = async (name) => {
    events.push(name);
    if (name === failing) throw new Error(`synthetic_${name}`);
  };
  const lifecycle = {
    ...context,
    getState: () => state,
    verify: async () => ({
      payload: context.root,
      manifest: {
        files: [{ path: "scripts/data-maintenance.mjs" }],
        sources: { postgres: { version: "16.15" } },
      },
    }),
    stop: async () => {
      events.push("stop");
      state = { ...state, phase: "stopped" };
    },
    start: async () => {
      assert.equal(await readMaintenance(context.io, context.root), null);
      events.push("start");
      state = { ...state, phase: "running" };
    },
  };
  const dependencies = {
    runtimeEnvironment: async () => ({}),
    pgControl: async (verb) => step(`pg-${verb}`),
    database: {
      verify: async () => step("verify"),
      space: async () => {},
      dump: async (file) => {
        await step("backup");
        await file.writeFile("synthetic dump");
      },
      candidate: async () => candidate,
      create: async () => ({ ...candidate, restored_oid: 2 }),
      swap: async () => step("swap"),
      finish: async () => step("finish"),
    },
    importPortableContainer: async (_c, directory) => {
      await context.io.write(join(directory, "database.ndjson"), "synthetic");
      return {
        sha256: "a".repeat(64),
        manifest: { release: context.entry, postgres_version: "16.15", database: {}, photos: [] },
        photoManifest: {},
      };
    },
    migratePortableShadow: async () => step("migrate"),
    withDataClient: async (_c, _name, operation) => operation({}),
    importPortableDatabase: async () => step("import"),
    restorePhotoDirectory: async () => step("photos"),
    runApprovedImport: async (_c, requestId, backup) => {
      const point = await backup({ orgId: "org", storeId: "store" }, "b".repeat(64));
      assert.equal(point.verified, true);
      assert.equal(point.sourceSha256, "b".repeat(64));
      assert.ok(events.includes("backup"));
      await step("v1");
      return { request_id: requestId, applied: true };
    },
    exportStore: async (_context, input) => {
      assert.equal(state.phase, "stopped");
      assert.ok(events.includes("backup"));
      await step("export");
      return { status: "store_exported", request_id: input.requestId };
    },
  };
  return { context, lifecycle, dependencies, events, getState: () => state };
}

const options = {
  path: "/synthetic.ldbackup",
  password: Buffer.from("synthetic-passphrase"),
  confirmation: "a".repeat(64),
};
test("approved store export quiesces writers and keeps a safety point before exporting", async (t) => {
  const f = await fixture(t);
  const result = await dataMaintenance(
    "export-store",
    {
      destination: "/new-store-export",
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
    f.lifecycle,
    f.dependencies,
  );
  assert.equal(result.status, "store_exported");
  assert.deepEqual(f.events, [
    "stop",
    "pg-start",
    "verify",
    "backup",
    "export",
    "verify",
    "pg-stop",
    "start",
  ]);
  assert.equal(await readMaintenance(f.context.io, f.context.root), null);
});
test("portable import preserves safety point, validates shadow/photos, then switches and resumes", async (t) => {
  const f = await fixture(t);
  const result = await dataMaintenance("portable-import", options, f.lifecycle, f.dependencies);
  assert.equal(result.status, "portable_restored");
  assert.match(result.safety_backup.id, /^b_/);
  assert.deepEqual(f.events, [
    "stop",
    "pg-start",
    "verify",
    "backup",
    "migrate",
    "import",
    "photos",
    "verify",
    "swap",
    "verify",
    "finish",
    "pg-stop",
    "start",
  ]);
  assert.equal(f.getState().phase, "running");
});

for (const failure of ["import", "photos", "swap", "finish", "pg-stop"])
  test(`portable interruption at ${failure} remains stopped with a durable recovery route`, async (t) => {
    const f = await fixture(t, failure);
    await assert.rejects(
      dataMaintenance("portable-import", options, f.lifecycle, f.dependencies),
      new RegExp(`synthetic_${failure}`),
    );
    const journal = await readMaintenance(f.context.io, f.context.root);
    assert.equal(journal.operation, "portable-import");
    assert.ok(journal.safety);
    assert.ok(journal.candidate);
    assert.equal(
      journal.phase,
      ["finish", "pg-stop"].includes(failure)
        ? "verified"
        : failure === "swap"
          ? "switching"
          : "restoring",
    );
    assert.equal(f.getState().phase, "stopped");
    assert.equal(f.events.includes("start"), false);
  });

test("approved v1 bridge binds the existing safety point to source digest under maintenance", async (t) => {
  const f = await fixture(t),
    requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const result = await dataMaintenance("v1-import", { requestId }, f.lifecycle, f.dependencies);
  assert.equal(result.request_id, requestId);
  assert.equal(result.applied, true);
  assert.ok(f.events.indexOf("backup") < f.events.indexOf("v1"));
  assert.equal(await readMaintenance(f.context.io, f.context.root), null);
});

test("inspection validates version before any state or service mutation", async (t) => {
  const f = await fixture(t);
  const result = await dataMaintenance(
    "portable-inspect",
    { path: options.path, password: options.password },
    f.lifecycle,
    f.dependencies,
  );
  assert.equal(result.status, "portable_verified");
  assert.deepEqual(f.events, []);
  const incompatible = {
    ...f.dependencies,
    importPortableContainer: async () => ({
      manifest: { release: { ...f.context.entry, migrations: "wrong" } },
    }),
  };
  await assert.rejects(
    dataMaintenance(
      "portable-inspect",
      { path: options.path, password: options.password },
      f.lifecycle,
      incompatible,
    ),
    /VERSION_MISMATCH/,
  );
  assert.deepEqual(f.events, []);
});
