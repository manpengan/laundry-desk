import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { canonicalManifest, digest } from "./companion-contract.mjs";
import { cleanEnvironment } from "./lifecycle-environment.mjs";
import { packageRuntimeEntry } from "./package-runtime-entry.mjs";
import { ENTRY_NAME } from "./runtime-entry-contract.mjs";
import { runtimeEntryFixture } from "./runtime-entry-test-fixture.mjs";

const execute = promisify(execFile);
const windowsOnly = { skip: process.platform !== "win32", timeout: 120000 };

async function runEntry(directory, args, env = {}) {
  return execute(
    join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(directory, ENTRY_NAME),
      ...args,
    ],
    { env: { ...cleanEnvironment(), ...env }, windowsHide: true, maxBuffer: 65536, timeout: 40000 },
  );
}

test(
  "WinPS 5.1 executes the generated fixed entry with injection environment stripped",
  windowsOnly,
  async (t) => {
    const fixture = await runtimeEntryFixture(t);
    await packageRuntimeEntry(fixture);
    const result = JSON.parse(
      (
        await runEntry(fixture.output, ["-Action", "status"], {
          NODE_OPTIONS: "--require entry-injection-must-not-run",
          NODE_PATH: "entry-injection-must-not-run",
          DATABASE_URL: "synthetic-not-forwarded",
          PSModulePath: "entry-injection-must-not-run",
        })
      ).stdout,
    );
    assert.equal(result.action, "status");
    assert.equal(result.manifest_sha256, fixture.manifestSha);
    assert.equal(result.node_options, null);
    assert.equal(result.node_path, null);
    assert.equal(result.policy, "Bypass");
    assert.equal(result.path, join(process.env.SystemRoot, "System32"));
    const id = `b_${"a".repeat(32)}`,
      confirmation = "b".repeat(64);
    const restored = JSON.parse(
      (
        await runEntry(fixture.output, [
          "-Action",
          "restore",
          "-BackupId",
          id,
          "-ConfirmationDigest",
          confirmation,
        ])
      ).stdout,
    );
    assert.equal(restored.backup_id, id);
    assert.equal(restored.confirmation, confirmation);
    for (const args of [
      ["-Action", "restore", "-BackupId", id],
      ["-Action", "status", "-BackupId", id],
      ["-Action", "backup-verify", "-BackupId", "../bad"],
    ])
      await assert.rejects(runEntry(fixture.output, args), (error) =>
        error.stderr.includes("WINDOWS_RUNTIME_ENTRY_ARGS_INVALID"),
      );
    await assert.rejects(
      runEntry(fixture.output, ["-Action", "status", "-Payload", fixture.payload]),
      (error) => error.stderr.includes("NamedParameterNotFound"),
    );
  },
);

test(
  "generated WinPS bootstrap rejects altered manifest/bootstrap/helpers and links before the launcher runs",
  windowsOnly,
  async (t) => {
    for (const mutation of [
      "manifest",
      "launcher",
      "node",
      "ui",
      "installer",
      "hardlink",
      "junction",
    ]) {
      const fixture = await runtimeEntryFixture(t);
      await packageRuntimeEntry(fixture);
      const payload = join(fixture.output, "payload");
      if (mutation === "manifest") {
        const changed = canonicalManifest({ ...fixture.manifest, source_git_sha: "d".repeat(40) });
        await writeFile(join(payload, "runtime-payload.json"), changed);
        await writeFile(
          join(fixture.output, "release-evidence.json"),
          JSON.stringify({ manifest_sha256: digest(changed) }),
        );
      } else if (mutation === "launcher")
        await appendFile(join(payload, "scripts/lifecycle-launch.ps1"), "throw 'must-not-run'\n");
      else if (mutation === "node") await appendFile(join(payload, "node/node.exe"), "tampered");
      else if (mutation === "ui")
        await appendFile(join(fixture.output, "runtime-entry-ui.ps1"), "throw 'must-not-run'\n");
      else if (mutation === "installer")
        await appendFile(
          join(fixture.output, "runtime-entry-install.ps1"),
          "throw 'must-not-run'\n",
        );
      else if (mutation === "hardlink")
        await link(join(payload, "scripts/lifecycle-launch.ps1"), join(fixture.root, "alias.ps1"));
      else {
        const moved = join(fixture.root, "moved-payload");
        await rename(payload, moved);
        await symlink(moved, payload, "junction");
      }
      await assert.rejects(runEntry(fixture.output, ["-Action", "status"]), (error) => {
        assert.equal(error.stdout.trim(), "");
        assert.match(error.stderr, /WINDOWS_RUNTIME_ENTRY_(?:INTEGRITY_FAILED|FAILED)/u);
        assert.equal(error.stderr.includes("must-not-run"), false);
        return true;
      });
    }
  },
);

test(
  "the ordinary-user installer creates independent private Programs entry and shortcuts that survive source removal",
  windowsOnly,
  async (t) => {
    const fixture = await runtimeEntryFixture(t);
    await packageRuntimeEntry(fixture);
    const local = join(fixture.root, "L"),
      roaming = join(fixture.root, "Roaming"),
      user = join(fixture.root, "UserProfile");
    const menu = join(roaming, "Microsoft/Windows/Start Menu/Programs");
    const desktop = join(user, "Desktop");
    await mkdir(local, { recursive: true });
    await mkdir(menu, { recursive: true });
    await mkdir(desktop, { recursive: true });
    const environment = { LOCALAPPDATA: local, APPDATA: roaming, USERPROFILE: user };
    assert.equal(
      JSON.parse((await runEntry(fixture.output, ["-Action", "install"], environment)).stdout)
        .action,
      "install",
    );
    const installed = join(local, "Programs/Laundry Desk Runtime V2", fixture.manifestSha);
    assert.ok((await readFile(join(installed, ENTRY_NAME))).length > 0);
    assert.equal(
      (await readdir(join(menu, "Laundry Desk Runtime V2"))).filter((name) => name.endsWith(".lnk"))
        .length,
      1,
    );
    assert.equal((await readdir(desktop)).filter((name) => name.endsWith(".lnk")).length, 1);
    // Repeat only the test-owned synthetic launcher; no real database or Windows task is involved.
    await runEntry(installed, ["-Action", "install"], environment);
    await rm(fixture.output, { recursive: true });
    await rm(fixture.payload, { recursive: true });
    const result = JSON.parse(
      (await runEntry(installed, ["-Action", "status"], environment)).stdout,
    );
    assert.equal(result.action, "status");
    assert.equal(result.manifest_sha256, fixture.manifestSha);
  },
);
