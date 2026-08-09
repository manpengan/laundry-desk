import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { SEMVER } from "./schema.mjs";

const execFileAsync = promisify(execFile);
const TEAM = /^[A-Z0-9]{10}$/u;
const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/u;
const PASSTHROUGH = ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "TMPDIR", "USER"];
const GIT_ENVIRONMENT = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  HOME: "/var/empty",
  LANG: "C",
  LC_ALL: "C",
});

function childEnvironment(env) {
  return Object.fromEntries(
    PASSTHROUGH.flatMap((key) => (typeof env[key] === "string" ? [[key, env[key]]] : [])),
  );
}

export async function execute(file, args, options = {}) {
  return await execFileAsync(file, [...args], {
    encoding: "utf8",
    env: options.env ?? childEnvironment(process.env),
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
  });
}

export async function readGitIdentity(repositoryRoot, run = execute) {
  const prefix = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    repositoryRoot,
  ];
  const [head, status] = await Promise.all([
    run("/usr/bin/git", [...prefix, "rev-parse", "HEAD"], {
      env: GIT_ENVIRONMENT,
      maxBuffer: 64 * 1024,
    }),
    run("/usr/bin/git", [...prefix, "status", "--porcelain=v1", "--untracked-files=all"], {
      env: GIT_ENVIRONMENT,
      maxBuffer: 2 * 1024 * 1024,
    }),
  ]);
  return Object.freeze({ head: head.stdout, status: status.stdout });
}

function singleField(text, name, pattern, code) {
  const values = [...text.matchAll(new RegExp(`^${name}=(${pattern})$`, "gmu"))];
  if (values.length !== 1 || values[0]?.[1] === undefined) throw new Error(code);
  return values[0][1];
}

async function plistValue(appPath, name, run) {
  const result = await run("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${name}`,
    join(appPath, "Contents", "Info.plist"),
  ]);
  return result.stdout.trim();
}

export async function inspectFormalApp(appPath, expected, run = execute) {
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  await run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  await run("/usr/bin/xcrun", ["stapler", "validate", appPath]);
  const displayed = await run("/usr/bin/codesign", [
    "--display",
    "--verbose=4",
    "--requirements",
    "-",
    appPath,
  ]);
  const text = `${displayed.stdout ?? ""}\n${displayed.stderr ?? ""}`;
  const identity = Object.freeze({
    bundleIdentifier: await plistValue(appPath, "CFBundleIdentifier", run),
    teamIdentifier: singleField(
      text,
      "TeamIdentifier",
      "[A-Z0-9]{10}",
      "RC_CODESIGN_IDENTITY_INVALID",
    ),
    version: await plistValue(appPath, "CFBundleShortVersionString", run),
  });
  if (
    !BUNDLE.test(identity.bundleIdentifier) ||
    !TEAM.test(identity.teamIdentifier) ||
    !SEMVER.test(identity.version) ||
    identity.bundleIdentifier !== expected.bundleIdentifier ||
    identity.version !== expected.version
  ) {
    throw new Error("RC_CODESIGN_IDENTITY_INVALID");
  }
  return identity;
}

export async function verifyFormalDiskImage(path, run = execute) {
  await run("/usr/bin/xcrun", ["stapler", "validate", path]);
  await run("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    path,
  ]);
}

export async function assertUniversalVerifier(appPath, run = execute) {
  const executable = join(appPath, "Contents", "MacOS", "Laundry Desk Release Candidate Verifier");
  const result = await run("/usr/bin/lipo", ["-archs", executable]);
  if (
    JSON.stringify(result.stdout.trim().split(/\s+/u).sort()) !==
    JSON.stringify(["arm64", "x86_64"])
  ) {
    throw new Error("RC_VERIFIER_NOT_UNIVERSAL");
  }
}

export async function inspectFormalProducts(input, version, run = execute) {
  const [counter, runtime, verifier] = await Promise.all([
    inspectFormalApp(input.counter.app, { bundleIdentifier: "com.laundry-desk.v2", version }, run),
    inspectFormalApp(
      input.runtime.app,
      { bundleIdentifier: "com.laundry-desk.runtime", version },
      run,
    ),
    inspectFormalApp(
      input.verifier_app,
      { bundleIdentifier: "com.laundry-desk.release-candidate-verifier", version },
      run,
    ),
    verifyFormalDiskImage(input.counter.dmg, run),
    verifyFormalDiskImage(input.runtime.dmg, run),
    assertUniversalVerifier(input.verifier_app, run),
  ]);
  if (
    counter.teamIdentifier !== runtime.teamIdentifier ||
    counter.teamIdentifier !== verifier.teamIdentifier
  ) {
    throw new Error("RC_TEAM_IDENTIFIER_MISMATCH");
  }
  return Object.freeze({ counter, runtime, verifier });
}
