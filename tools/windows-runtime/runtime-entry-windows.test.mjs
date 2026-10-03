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
import { ENTRY_NAME, OPERATOR_HELPERS } from "./runtime-entry-contract.mjs";
import { runtimeEntryFixture } from "./runtime-entry-test-fixture.mjs";
import {
  shortcutSaveDiagnostic,
  shortcutSaveFailureCode,
} from "./runtime-entry-save-diagnostic-fixture.mjs";
import {
  shortcutInstallationWithNameMatrix,
  shortcutNameMatrix,
} from "./runtime-entry-shortcut-name-matrix-fixture.mjs";

const execute = promisify(execFile);
const windowsOnly = { skip: process.platform !== "win32", timeout: 120000 };

test(
  "WinPS 5.1 parses every generated operator script, including the GUI",
  windowsOnly,
  async (t) => {
    const fixture = await runtimeEntryFixture(t);
    await packageRuntimeEntry(fixture);
    for (const name of [ENTRY_NAME, ...OPERATOR_HELPERS]) {
      const bytes = await readFile(join(fixture.output, name));
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      await execute(
        join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$errors=$null; $tokens=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:LAUNDRY_PS_PARSE_FILE,[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count -ne 0) { throw 'WINDOWS_RUNTIME_ENTRY_POWERSHELL_SYNTAX_INVALID' }",
        ],
        {
          env: { ...cleanEnvironment(), LAUNDRY_PS_PARSE_FILE: join(fixture.output, name) },
          timeout: 30000,
          maxBuffer: 65536,
          windowsHide: true,
        },
      );
    }
  },
);

async function runEntry(fixture, args, env = {}, directory = fixture.output) {
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
    {
      cwd: fixture.root,
      env: { ...cleanEnvironment(), ...env },
      windowsHide: true,
      maxBuffer: 65536,
      timeout: 40000,
    },
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
        await runEntry(fixture, ["-Action", "status"], {
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
        await runEntry(fixture, [
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
      await assert.rejects(runEntry(fixture, args), (error) =>
        error.stderr.includes("WINDOWS_RUNTIME_ENTRY_ARGS_INVALID"),
      );
    await assert.rejects(
      runEntry(fixture, ["-Action", "status", "-Payload", fixture.payload]),
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
      "shortcut",
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
      else if (mutation === "shortcut")
        await appendFile(
          join(fixture.output, "runtime-entry-shortcut.ps1"),
          "throw 'must-not-run'\n",
        );
      else if (mutation === "hardlink")
        await link(join(payload, "scripts/lifecycle-launch.ps1"), join(fixture.root, "alias.ps1"));
      else {
        const moved = join(fixture.root, "moved-payload");
        await rename(payload, moved);
        await symlink(moved, payload, "junction");
      }
      await assert.rejects(runEntry(fixture, ["-Action", "status"]), (error) => {
        assert.equal(error.stdout.trim(), "");
        assert.match(error.stderr, /WINDOWS_RUNTIME_ENTRY_(?:INTEGRITY_FAILED|FAILED)/u);
        assert.equal(error.stderr.includes("must-not-run"), false);
        return true;
      });
    }
  },
);

test(
  "upgrade retains a bound Programs maintenance entry after its distribution is removed",
  windowsOnly,
  async (t) => {
    const fixture = await runtimeEntryFixture(t);
    await packageRuntimeEntry(fixture);
    const local = join(fixture.root, "L"),
      roaming = join(fixture.root, "Roaming"),
      user = join(fixture.root, "UserProfile");
    const menu = join(roaming, "Microsoft/Windows/Start Menu/Programs");
    await mkdir(local, { recursive: true });
    await mkdir(menu, { recursive: true });
    await mkdir(join(user, "AppData/Local"), { recursive: true });
    await mkdir(join(user, "AppData/Roaming"), { recursive: true });
    const environment = { LOCALAPPDATA: local, APPDATA: roaming, USERPROFILE: user };
    await runEntry(fixture, ["-Action", "install"], environment);
    const previous = join(local, "Programs/Laundry Desk Runtime V2", fixture.manifestSha);
    const previousBytes = await readFile(join(previous, ENTRY_NAME));
    const candidate = await runtimeEntryFixture(t);
    const nextManifest = { ...candidate.manifest, runtime_release: "0.1.1-win-dev" };
    const nextBytes = canonicalManifest(nextManifest);
    await writeFile(join(candidate.payload, "runtime-payload.json"), nextBytes);
    const next = { ...candidate, manifest: nextManifest, manifestSha: digest(nextBytes) };
    assert.notEqual(next.manifestSha, fixture.manifestSha);
    await packageRuntimeEntry(next);
    const upgraded = JSON.parse((await runEntry(next, ["-Action", "upgrade"], environment)).stdout);
    assert.equal(upgraded.action, "upgrade");
    const installed = join(local, "Programs/Laundry Desk Runtime V2", next.manifestSha);
    assert.ok((await readFile(join(installed, ENTRY_NAME))).length > 0);
    assert.deepEqual(await readFile(join(previous, ENTRY_NAME)), previousBytes);
    assert.equal((await readdir(join(menu, "Laundry Desk Runtime V2"))).length, 2);
    await rm(next.output, { recursive: true });
    await rm(next.payload, { recursive: true });
    const result = JSON.parse(
      (await runEntry(fixture, ["-Action", "status"], environment, installed)).stdout,
    );
    assert.equal(result.action, "status");
    assert.equal(result.manifest_sha256, next.manifestSha);
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
    await mkdir(join(user, "AppData/Local"), { recursive: true });
    await mkdir(join(user, "AppData/Roaming"), { recursive: true });
    const environment = { LOCALAPPDATA: local, APPDATA: roaming, USERPROFILE: user };
    let first;
    try {
      first = await runEntry(fixture, ["-Action", "install"], environment);
    } catch (error) {
      const code = shortcutSaveFailureCode(error.stderr);
      if (!code) throw error;
      throw await shortcutInstallationWithNameMatrix(
        code,
        () => shortcutSaveDiagnostic(fixture, environment),
        fixture,
        environment,
      );
    }
    assert.equal(JSON.parse(first.stdout).action, "install");
    const installed = join(local, "Programs/Laundry Desk Runtime V2", fixture.manifestSha);
    assert.ok((await readFile(join(installed, ENTRY_NAME))).length > 0);
    assert.equal(
      (await readdir(join(menu, "Laundry Desk Runtime V2"))).filter((name) => name.endsWith(".lnk"))
        .length,
      1,
    );
    assert.equal((await readdir(desktop)).filter((name) => name.endsWith(".lnk")).length, 1);
    // Repeat only the test-owned synthetic launcher; no real database or Windows task is involved.
    await runEntry(fixture, ["-Action", "install"], environment, installed);
    await rm(fixture.output, { recursive: true });
    await rm(fixture.payload, { recursive: true });
    const result = JSON.parse(
      (await runEntry(fixture, ["-Action", "status"], environment, installed)).stdout,
    );
    assert.equal(result.action, "status");
    assert.equal(result.manifest_sha256, fixture.manifestSha);
  },
);

test(
  "installer reports a stable shortcut-stage error and preserves a conflicting Start Menu file",
  windowsOnly,
  async (t) => {
    const fixture = await runtimeEntryFixture(t);
    await packageRuntimeEntry(fixture);
    const local = join(fixture.root, "L"),
      roaming = join(fixture.root, "Roaming"),
      user = join(fixture.root, "UserProfile");
    const menu = join(roaming, "Microsoft/Windows/Start Menu/Programs");
    await mkdir(local, { recursive: true });
    await mkdir(menu, { recursive: true });
    await mkdir(join(user, "AppData/Local"), { recursive: true });
    await mkdir(join(user, "AppData/Roaming"), { recursive: true });
    const conflict = join(menu, "Laundry Desk Runtime V2");
    await writeFile(conflict, "unrelated Start Menu entry\n", { flag: "wx" });
    await assert.rejects(
      runEntry(fixture, ["-Action", "install"], {
        LOCALAPPDATA: local,
        APPDATA: roaming,
        USERPROFILE: user,
      }),
      (error) => {
        assert.equal(error.stdout.trim(), "");
        assert.equal(error.stderr.trim(), "WINDOWS_RUNTIME_ENTRY_INSTALL_MENU_FAILED");
        assert.equal(error.stderr.includes(fixture.root), false);
        return true;
      },
    );
    assert.equal(await readFile(conflict, "utf8"), "unrelated Start Menu entry\n");
    const parent = join(local, "Programs/Laundry Desk Runtime V2");
    assert.deepEqual(await readdir(parent), [fixture.manifestSha]);
    assert.ok((await readFile(join(parent, fixture.manifestSha, ENTRY_NAME))).length > 0);
  },
);

test(
  "shortcut creation rejects an existing directory before COM loading without replacing it",
  windowsOnly,
  async (t) => {
    const fixture = await runtimeEntryFixture(t);
    await packageRuntimeEntry(fixture);
    const local = join(fixture.root, "L"),
      roaming = join(fixture.root, "Roaming"),
      user = join(fixture.root, "UserProfile");
    const menu = join(roaming, "Microsoft/Windows/Start Menu/Programs/Laundry Desk Runtime V2");
    await mkdir(local, { recursive: true });
    await mkdir(menu, { recursive: true });
    await mkdir(join(user, "AppData/Local"), { recursive: true });
    await mkdir(join(user, "AppData/Roaming"), { recursive: true });
    const conflict = join(
      menu,
      `Laundry Runtime V2 安装与维护 (${fixture.manifestSha.slice(0, 12)}).lnk`,
    );
    await mkdir(conflict);
    const sentinel = join(conflict, "unrelated.txt");
    await writeFile(sentinel, "unrelated shortcut directory\n", { flag: "wx" });
    await assert.rejects(
      runEntry(fixture, ["-Action", "install"], {
        LOCALAPPDATA: local,
        APPDATA: roaming,
        USERPROFILE: user,
      }),
      (error) => {
        assert.equal(error.stdout.trim(), "");
        assert.equal(error.stderr.trim(), "WINDOWS_RUNTIME_ENTRY_SHORTCUT_CONFLICT");
        assert.equal(error.stderr.includes(fixture.root), false);
        return true;
      },
    );
    assert.equal(await readFile(sentinel, "utf8"), "unrelated shortcut directory\n");
    assert.deepEqual(await readdir(menu), [conflict.split(/[/\\]/u).at(-1)]);
    const report = await shortcutSaveDiagnostic(
      fixture,
      { LOCALAPPDATA: local, APPDATA: roaming, USERPROFILE: user },
      { directory: menu },
    );
    assert.equal(report.diagnostic_result, "failed");
    assert.equal(report.code, "WINDOWS_RUNTIME_ENTRY_SHORTCUT_CONFLICT");
    assert.equal(report.native.stage, "COM_LOAD");
    assert.equal(Number.isInteger(report.native.hresult), true);
    assert.equal(JSON.stringify(report).includes(fixture.root), false);
    assert.equal(await readFile(sentinel, "utf8"), "unrelated shortcut directory\n");
    const matrix = await shortcutNameMatrix(fixture, {
      LOCALAPPDATA: local,
      APPDATA: roaming,
      USERPROFILE: user,
    });
    assert.equal(matrix.matrix_result, "complete", JSON.stringify(matrix));
    for (const entry of matrix.cases) {
      assert.equal(entry.report.diagnostic_result, "succeeded", JSON.stringify(matrix));
      assert.equal(
        Object.values(entry.facts).every((value) => value === true),
        true,
      );
    }
    assert.equal(JSON.stringify(matrix).includes(fixture.root), false);
  },
);
