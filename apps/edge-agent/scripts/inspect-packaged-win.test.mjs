import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { defaultSignatureStatus, inspectPackagedWindowsSoftware } from "./inspect-packaged-win.mjs";
import { loadWindowsProfile, stageWindowsProfile } from "./windows-profile.mjs";
import { cp } from "node:fs/promises";
import { WINDOWS_PACKAGE_VERSION } from "./windows-package-version.mjs";

const INSTALLER = `laundry-desk-v2-${WINDOWS_PACKAGE_VERSION}-windows-x64-development-only.exe`;
const HELPER = "laundry-windows-helper.exe";
const SOURCE_GIT_SHA = "a".repeat(40);
const SIGNATURE_OUTPUT =
  "PROCESS_STARTED\r\nMODULE_READY\r\nQUERY_STARTED\r\nQUERY_COMPLETED\r\nNotSigned\r\n";

test("closes a real child stdin so an EOF-dependent signature query can finish", async () => {
  const execute = promisify(execFile);
  const script = `process.stdin.resume(); process.stdin.once('end', () => process.stdout.write(${JSON.stringify(SIGNATURE_OUTPUT)}));`;
  const status = await defaultSignatureStatus(join(tmpdir(), "installer.exe"), {
    systemRoot: join(tmpdir(), "windows"),
    run: (_command, _args, options) =>
      execute(process.execPath, ["-e", script], { ...options, timeout: 2_000 }),
  });
  assert.equal(status, "NotSigned");
});

test("bounds cold-start Authenticode queries without exposing the parent environment", async () => {
  const systemRoot = join(tmpdir(), "windows");
  const path = join(tmpdir(), "installer.exe");
  let inputClosed = false;
  let progress = [];
  const status = await defaultSignatureStatus(path, {
    systemRoot,
    artifactKind: "installer",
    reportProgress: (event) => {
      progress = [...progress, event];
    },
    run: (command, args, options) => {
      assert.equal(
        command,
        join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      );
      assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
      assert.match(args[4], /\$PSModuleAutoLoadingPreference = 'None'/u);
      assert.match(
        args[4],
        /Import-Module \(\$PSHOME \+ '\\Modules\\Microsoft\.PowerShell\.Security\\Microsoft\.PowerShell\.Security\.psd1'\)/u,
      );
      assert.match(args[4], /Microsoft\.PowerShell\.Security\\Get-AuthenticodeSignature/u);
      assert.match(args[4], /exit 0$/u);
      assert.equal(options.timeout, 60_000);
      assert.equal(options.maxBuffer, 8_192);
      assert.equal(options.windowsHide, true);
      assert.deepEqual(options.env, {
        LAUNDRY_INSPECT_PATH: path,
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
      });
      return Object.assign(Promise.resolve({ stdout: SIGNATURE_OUTPUT, stderr: "" }), {
        child: {
          stdin: {
            end: () => {
              inputClosed = true;
            },
          },
        },
      });
    },
  });
  assert.equal(status, "NotSigned");
  assert.equal(inputClosed, true);
  assert.deepEqual(
    progress.map(({ stage }) => stage),
    ["PROCESS_START", "QUERY_COMPLETED", "PROCESS_EXIT"],
  );
  for (const event of progress) {
    assert.deepEqual(Object.keys(event).sort(), ["artifact_kind", "elapsed_ms", "stage"]);
    assert.equal(event.artifact_kind, "installer");
    assert.ok(Number.isSafeInteger(event.elapsed_ms) && event.elapsed_ms >= 0);
  }
});

test("fails closed with safe reasons for Authenticode timeouts and invalid responses", async () => {
  const systemRoot = join(tmpdir(), "windows");
  const path = join(tmpdir(), "installer.exe");
  for (const [failure, reason, lastStage] of [
    [
      {
        killed: true,
        code: null,
        signal: "SIGTERM",
        stdout: "PROCESS_STARTED\nMODULE_READY\nQUERY_STARTED\n",
      },
      "TIMEOUT",
      "QUERY_STARTED",
    ],
    [new Error("private process diagnostics"), "QUERY_FAILED", "PROCESS_START"],
  ]) {
    let progress = [];
    await assert.rejects(
      defaultSignatureStatus(path, {
        systemRoot,
        reportProgress: (event) => {
          progress = [...progress, event];
        },
        run: async () => {
          throw failure;
        },
      }),
      { message: `WINDOWS_PACKAGE_SIGNATURE_${reason}` },
    );
    assert.equal(progress.at(-1).stage, lastStage);
    assert.doesNotMatch(JSON.stringify(progress), /private|installer\.exe/u);
  }
  for (const output of [
    { stdout: SIGNATURE_OUTPUT, stderr: "private diagnostic" },
    { stdout: SIGNATURE_OUTPUT + "UnknownError\n", stderr: "" },
    { stdout: "NotSigned\nUnknownError\n", stderr: "" },
    { stdout: "", stderr: "" },
  ]) {
    await assert.rejects(defaultSignatureStatus(path, { systemRoot, run: async () => output }), {
      message: "WINDOWS_PACKAGE_SIGNATURE_OUTPUT_INVALID",
    });
  }
});

function x64PeFixture() {
  const bytes = Buffer.alloc(256);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "binary");
  bytes.writeUInt16LE(0x8664, 0x84);
  return bytes;
}

async function fixture(t, profileId = "generic") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-win-inspection-")));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const releaseRoot = join(root, "release");
  const resources = join(releaseRoot, "win-unpacked", "resources");
  const spa = join(resources, "spa");
  const helperRoot = join(resources, "windows-helper");
  const provenanceRoot = join(resources, "build-provenance");
  const { profile } = await loadWindowsProfile({ profileId });
  const appName = profile.display_name + ".exe";
  const installerName =
    profileId === "generic" ? INSTALLER : INSTALLER.replace("v2-", "v2-hongfa-");
  await Promise.all([
    mkdir(join(spa, "bundles"), { recursive: true }),
    mkdir(join(resources, "update"), { recursive: true }),
    mkdir(helperRoot, { recursive: true }),
    mkdir(provenanceRoot, { recursive: true }),
  ]);
  const html = Buffer.from("<!doctype html>\n");
  const manifest = `${JSON.stringify(
    {
      version: 1,
      entries: {
        "index.html": {
          sha256: createHash("sha256").update(html).digest("hex"),
          mime: "text/html; charset=utf-8",
          bytes: html.byteLength,
        },
      },
    },
    null,
    2,
  )}\n`;
  const bundle = createHash("sha256").update(manifest).digest("hex");
  await mkdir(join(spa, "bundles", bundle));
  const helper = Buffer.from("fixture helper\n");
  const helperDigest = createHash("sha256").update(helper).digest("hex");
  await Promise.all([
    writeFile(join(releaseRoot, "win-unpacked", appName), x64PeFixture()),
    writeFile(join(releaseRoot, installerName), "fixture installer\n"),
    writeFile(join(releaseRoot, installerName + ".blockmap"), "fixture blockmap\n"),
    writeFile(join(resources, "app.asar"), "fixture asar\n"),
    writeFile(
      join(resources, "update", "update-config.json"),
      '{"schema_version":1,"enabled":false}\n',
    ),
    writeFile(join(helperRoot, HELPER), helper),
    writeFile(join(helperRoot, `${HELPER}.sha256`), `${helperDigest}\n`),
    writeFile(
      join(provenanceRoot, "windows-source.json"),
      `${JSON.stringify({
        assurance: "development_only",
        schema_version: 1,
        source_git_sha: SOURCE_GIT_SHA,
        source_tree: "clean",
        windows_helper_sha256: helperDigest,
      })}\n`,
    ),
    writeFile(join(spa, "manifest.json"), manifest),
    writeFile(join(spa, "bundles", bundle, "index.html"), html),
    writeFile(join(resources, "windows-runtime-guide.txt"), "Laundry Runtime V2.cmd\n"),
  ]);
  const staged = await stageWindowsProfile({
    profileId,
    expectedGitSha: SOURCE_GIT_SHA,
    targetRoot: join(root, "windows-profile"),
  });
  await cp(staged.targetRoot, join(resources, "distribution-profile"), { recursive: true });
  return { bundle, helperDigest, helperRoot, provenanceRoot, releaseRoot, resources };
}

test("inspects exact x64 unsigned NSIS, helper and SPA evidence", async (t) => {
  const setup = await fixture(t);
  let checking = false;
  let kinds = [];

  const evidence = await inspectPackagedWindowsSoftware({
    platform: "win32",
    releaseRoot: setup.releaseRoot,
    expectedGitSha: SOURCE_GIT_SHA,
    signatureStatus: async (_path, { artifactKind }) => {
      assert.equal(checking, false, "app and installer checks must not overlap");
      checking = true;
      kinds = [...kinds, artifactKind];
      await Promise.resolve();
      checking = false;
      return "NotSigned";
    },
  });

  assert.equal(evidence.app_id, "com.laundry-desk.v2");
  assert.equal(evidence.architecture, "x64");
  assert.equal(evidence.assurance, "software_only");
  assert.equal(evidence.helper_sha256, setup.helperDigest);
  assert.equal(evidence.source_git_sha, SOURCE_GIT_SHA);
  assert.equal(evidence.source_tree, "clean");
  assert.equal(evidence.spa_bundle, setup.bundle);
  assert.match(evidence.app_sha256, /^[0-9a-f]{64}$/u);
  assert.match(evidence.installer_sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(kinds, ["app", "installer"]);
});

test("Hongfa has separate executable identity with the same fixed V2 resources", async (t) => {
  const setup = await fixture(t, "hongfa");
  const evidence = await inspectPackagedWindowsSoftware({
    platform: "win32",
    profileId: "hongfa",
    releaseRoot: setup.releaseRoot,
    expectedGitSha: SOURCE_GIT_SHA,
    signatureStatus: async () => "NotSigned",
  });
  assert.equal(evidence.app_id, "com.laundry-desk.v2.hongfa");
  assert.equal(evidence.profile_id, "hongfa");
  assert.match(evidence.profile_sha256, /^[a-f0-9]{64}$/u);
  const binding = join(setup.resources, "distribution-profile", "binding.json");
  const value = JSON.parse(await readFile(binding, "utf8"));
  await writeFile(binding, JSON.stringify({ ...value, source_git_sha: "b".repeat(40) }));
  await assert.rejects(
    inspectPackagedWindowsSoftware({
      platform: "win32",
      profileId: "hongfa",
      releaseRoot: setup.releaseRoot,
      expectedGitSha: SOURCE_GIT_SHA,
      signatureStatus: async () => "NotSigned",
    }),
    /WINDOWS_PROFILE_BINDING_INVALID/u,
  );
});

test("rejects helper tampering and signed or unknown development-only artifacts", async (t) => {
  const tampered = await fixture(t);
  await writeFile(join(tampered.helperRoot, HELPER), "tampered\n");
  await assert.rejects(
    () =>
      inspectPackagedWindowsSoftware({
        platform: "win32",
        releaseRoot: tampered.releaseRoot,
        expectedGitSha: SOURCE_GIT_SHA,
        signatureStatus: async () => "NotSigned",
      }),
    /helper digest does not match/u,
  );

  const signed = await fixture(t);
  for (const status of ["Valid", "UnknownError", "NotTrusted"]) {
    await assert.rejects(
      () =>
        inspectPackagedWindowsSoftware({
          platform: "win32",
          releaseRoot: signed.releaseRoot,
          expectedGitSha: SOURCE_GIT_SHA,
          signatureStatus: async () => status,
        }),
      /explicitly unsigned/u,
    );
  }
});

test("rejects missing, stale, or helper-detached build provenance", async (t) => {
  const missingExpectation = await fixture(t);
  await assert.rejects(
    () =>
      inspectPackagedWindowsSoftware({
        platform: "win32",
        releaseRoot: missingExpectation.releaseRoot,
        signatureStatus: async () => "NotSigned",
      }),
    /PROVENANCE_EXPECTATION_INVALID/u,
  );

  const stale = await fixture(t);
  await assert.rejects(
    () =>
      inspectPackagedWindowsSoftware({
        platform: "win32",
        releaseRoot: stale.releaseRoot,
        expectedGitSha: "b".repeat(40),
        signatureStatus: async () => "NotSigned",
      }),
    /PROVENANCE_INVALID/u,
  );

  const detached = await fixture(t);
  const path = join(detached.provenanceRoot, "windows-source.json");
  const provenance = JSON.parse(await readFile(path, "utf8"));
  await writeFile(
    path,
    `${JSON.stringify({ ...provenance, windows_helper_sha256: "f".repeat(64) })}\n`,
  );
  await assert.rejects(
    () =>
      inspectPackagedWindowsSoftware({
        platform: "win32",
        releaseRoot: detached.releaseRoot,
        expectedGitSha: SOURCE_GIT_SHA,
        signatureStatus: async () => "NotSigned",
      }),
    /PROVENANCE_INVALID/u,
  );
});
