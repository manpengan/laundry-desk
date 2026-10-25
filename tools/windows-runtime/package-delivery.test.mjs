import assert from "node:assert/strict";
import { mkdirSync, watch, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { link, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { digest } from "./companion-contract.mjs";
import { hashFile, inventory } from "./companion-files.mjs";
import { EXECUTABLES, requireDeliveryInput } from "./package-delivery-contract.mjs";
import { packageWindowsDelivery } from "./package-delivery.mjs";
import { packageRuntimeEntry } from "./package-runtime-entry.mjs";
import { runtimeEntryFixture } from "./runtime-entry-test-fixture.mjs";

async function fixture(t) {
  const base = await runtimeEntryFixture(t);
  const runtime = await packageRuntimeEntry(base);
  const counters = {};
  for (const profile of ["generic", "hongfa"]) {
    const installer = join(base.root, `${profile}.exe`);
    // Structural receipts only; no synthetic binary is executed or counted as acceptance.
    await writeFile(installer, `synthetic installer: ${profile}`);
    const report = {
      runtime_maintenance: {
        source_git_sha: base.sourceSha,
        manifest_sha256: base.manifestSha,
        entry_sha256: runtime.entry_sha256,
      },
      source_git_sha: base.sourceSha,
      profile,
      assurance: "development_only",
      installer_sha256: (await hashFile(installer)).sha256,
      installed: {
        [EXECUTABLES[profile]]: "1".repeat(64),
        "resources/app.asar": "2".repeat(64),
        "resources/distribution-profile/binding.json": "3".repeat(64),
      },
    };
    const path = join(base.root, `counter-installed-${profile}.json`);
    await writeFile(path, JSON.stringify(report));
    counters[profile] = {
      installer,
      installed_report: path,
      report_sha256: (await hashFile(path)).sha256,
    };
  }
  return {
    base,
    output: join(base.root, "delivery"),
    input: {
      schema: "laundry.windows.delivery-input",
      version: 1,
      source_git_sha: base.sourceSha,
      runtime_entry: {
        directory: runtime.output,
        evidence_sha256: (await hashFile(join(runtime.output, "release-evidence.json"))).sha256,
        manifest_sha256: base.manifestSha,
      },
      counters,
    },
  };
}

async function changedReceipt(input, update) {
  const previous = input.counters.generic;
  const report = JSON.parse(await readFile(previous.installed_report, "utf8"));
  await writeFile(previous.installed_report, JSON.stringify(update(report)));
  return {
    ...input,
    counters: {
      ...input.counters,
      generic: {
        ...previous,
        report_sha256: (await hashFile(previous.installed_report)).sha256,
      },
    },
  };
}

function observeOutput(t, base, output, mutation) {
  const state = { injected: false, error: null };
  let closed = false;
  const inject = () => {
    if (state.injected) return;
    state.injected = true;
    try {
      mutation(output);
    } catch (error) {
      state.error = error;
    }
  };
  const parentWatcher = watch(base.root, { persistent: false }, (_event, name) => {
    if (closed || name !== "delivery" || state.injected) return;
    inject();
  });
  t.after(() => {
    closed = true;
    parentWatcher.close();
  });
  return state;
}

function injectAfterWrite(t, target, mutation) {
  const state = { injected: false };
  const original = fsPromises.writeFile;
  const mocked = t.mock.method(fsPromises, "writeFile", async (...args) => {
    const result = await original(...args);
    if (args[0] === target && !state.injected) {
      state.injected = true;
      mutation();
    }
    return result;
  });
  // Keep real filesystem writes, while making the concurrent insertion point
  // deterministic instead of depending on OS watcher event coalescing latency.
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return state;
}

test("a complete same-source synthetic delivery has copied bytes, receipts, instructions and checksums", async (t) => {
  const { input, output, base } = await fixture(t);
  const result = await packageWindowsDelivery(input, output);
  const indexBytes = await readFile(join(output, "delivery-index.json"));
  const index = JSON.parse(indexBytes);
  assert.equal(result.index_sha256, digest(indexBytes));
  assert.equal(index.source_git_sha, input.source_git_sha);
  assert.equal(index.assurance, "development_only");
  assert.equal(index.verification.operational_admission, "pending");
  assert.deepEqual(
    index.counters.map(({ profile }) => profile),
    ["generic", "hongfa"],
  );
  assert.equal(index.runtime.manifest_sha256, base.manifestSha);
  for (const file of index.files)
    assert.deepEqual(await hashFile(join(output, file.path)), {
      size: file.size,
      sha256: file.sha256,
    });
  const sums = await readFile(join(output, "SHA256SUMS"), "utf8");
  const actual = (await inventory(output)).files;
  assert.equal(actual.length, result.files);
  assert.equal(
    sums,
    actual
      .filter(({ path }) => path !== "SHA256SUMS")
      .map(({ path, sha256 }) => `${sha256}  ${path}\n`)
      .join(""),
  );
  const guide = await readFile(join(output, "README.zh-CN.md"), "utf8");
  assert.match(guide, /Laundry Runtime V2\.cmd/u);
  assert.match(guide, /跨迁移升级\/回退/u);
  assert.match(guide, /人工选择备份/u);
  assert.equal(indexBytes.includes(Buffer.from(base.root)), false);
});

test("external receipt digests and installer hashes cannot be replaced by self-reported identity", async (t) => {
  const { input, output } = await fixture(t);
  await assert.rejects(
    packageWindowsDelivery(
      { ...input, runtime_entry: { ...input.runtime_entry, evidence_sha256: "0".repeat(64) } },
      output,
    ),
    /RECEIPT_DIGEST_INVALID/u,
  );
  await writeFile(input.counters.generic.installed_report, "{}");
  await assert.rejects(packageWindowsDelivery(input, output), /RECEIPT_DIGEST_INVALID/u);
  await assert.rejects(lstat(output), { code: "ENOENT" });
});

test("counter profile, source and Runtime binding must all agree with the pinned candidate", async (t) => {
  for (const update of [
    (report) => ({ ...report, source_git_sha: "c".repeat(40) }),
    (report) => ({ ...report, profile: "hongfa" }),
    (report) => ({
      ...report,
      runtime_maintenance: { ...report.runtime_maintenance, manifest_sha256: "d".repeat(64) },
    }),
    (report) => ({ ...report, secret: "must never enter the output" }),
  ]) {
    const { input, output } = await fixture(t);
    await assert.rejects(
      packageWindowsDelivery(await changedReceipt(input, update), output),
      /COUNTER_BINDING_INVALID/u,
    );
    await assert.rejects(lstat(output), { code: "ENOENT" });
  }
});

test("modified installer, Runtime payload, operator helper and unlisted files fail before publication", async (t) => {
  for (const mutation of ["installer", "payload", "helper", "extra", "empty"]) {
    const { input, output } = await fixture(t);
    const root = input.runtime_entry.directory;
    if (mutation === "installer") await writeFile(input.counters.generic.installer, "changed");
    if (mutation === "payload") await writeFile(join(root, "payload/metadata/schema.md"), "x");
    if (mutation === "helper") await writeFile(join(root, "runtime-entry-ui.ps1"), "x");
    if (mutation === "extra") await writeFile(join(root, "credentials.json"), "secret");
    if (mutation === "empty") await mkdir(join(root, "unlisted"));
    await assert.rejects(
      packageWindowsDelivery(input, output),
      /(?:INSTALLER_DIGEST_INVALID|INVENTORY_MISMATCH)/u,
    );
    await assert.rejects(lstat(output), { code: "ENOENT" });
  }
});

test("an existing destination is preserved and nested output or linked input is rejected", async (t) => {
  const { input, output, base } = await fixture(t);
  await mkdir(output);
  const sentinel = join(output, "user-file.txt");
  await writeFile(sentinel, "preserve");
  await assert.rejects(packageWindowsDelivery(input, output), /OUTPUT_EXISTS/u);
  assert.equal(await readFile(sentinel, "utf8"), "preserve");
  await assert.rejects(
    packageWindowsDelivery(input, join(input.runtime_entry.directory, "nested")),
    /OUTPUT_INSIDE_INPUT/u,
  );
  await link(input.counters.generic.installer, join(base.root, "aliased.exe"));
  await assert.rejects(
    packageWindowsDelivery(input, join(base.root, "other-delivery")),
    /FILE_INVALID/u,
  );
});

test("delivery inputs require both profiles, external scalar hashes and absolute paths", async (t) => {
  const { input } = await fixture(t);
  for (const candidate of [
    { ...input, source_git_sha: "invalid" },
    { ...input, counters: { generic: input.counters.generic } },
    { ...input, runtime_entry: { ...input.runtime_entry, directory: "relative" } },
    {
      ...input,
      runtime_entry: {
        ...input.runtime_entry,
        evidence_sha256: [input.runtime_entry.evidence_sha256],
      },
    },
  ])
    assert.throws(() => requireDeliveryInput(candidate), /(?:INPUT|PATH)_INVALID/u);
});

test("a concurrently added output file or empty directory is rejected instead of endorsed", async (t) => {
  for (const kind of ["file", "directory"]) {
    const { input, output, base } = await fixture(t);
    const observed = observeOutput(t, base, output, (directory) => {
      if (kind === "file")
        writeFileSync(join(directory, "operator-private-note.txt"), "synthetic private note");
      else mkdirSync(join(directory, "unapproved-empty"));
    });
    await assert.rejects(
      packageWindowsDelivery(input, output),
      /OUTPUT_INVENTORY_MISMATCH/u,
      `injection ${kind}`,
    );
    assert.equal(observed.injected, true);
    assert.equal(observed.error, null);
    await assert.rejects(lstat(output), { code: "ENOENT" });
  }
});

test("unknown additions after index or checksum creation still fail the closed output check", async (t) => {
  for (const stage of ["delivery-index.json", "SHA256SUMS"]) {
    const { input, output } = await fixture(t);
    const observed = injectAfterWrite(t, join(output, stage), () => {
      writeFileSync(join(output, "late-private-note.txt"), "synthetic late addition");
    });
    const failure = await packageWindowsDelivery(input, output).then(
      () => null,
      (error) => error,
    );
    assert.match(
      failure?.message ?? `completed at ${stage}: ${JSON.stringify(observed)}`,
      /OUTPUT_INVENTORY_MISMATCH/u,
    );
    assert.equal(observed.injected, true);
    await assert.rejects(lstat(output), { code: "ENOENT" });
  }
});

test("altered approved output bytes cannot be incorporated into regenerated checksums", async (t) => {
  const { input, output } = await fixture(t);
  const observed = injectAfterWrite(t, join(output, "delivery-index.json"), () => {
    writeFileSync(join(output, "Counter/counter-generic.exe"), "modified after copying");
  });
  await assert.rejects(packageWindowsDelivery(input, output), /OUTPUT_INVENTORY_MISMATCH/u);
  assert.equal(observed.injected, true);
  await assert.rejects(lstat(output), { code: "ENOENT" });
});
