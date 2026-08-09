import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { inspectFormalApp } from "./platform.mjs";
import { canonicalJson } from "./schema.mjs";
import { canonicalAbsolutePath, ensureRealDirectory } from "./safe-io.mjs";

const execute = promisify(execFile);
const toolRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(toolRoot, "../..");
const appName = "Laundry Desk Release Candidate Verifier.app";
const executableName = "Laundry Desk Release Candidate Verifier";
const architectures = Object.freeze(["arm64", "x86_64"]);
const forbiddenCredentialEnvironment = Object.freeze([
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
]);

function parseArguments(args) {
  if (args.length !== 2 || !["--formal", "--testing"].includes(args[0])) {
    throw new Error("RC_VERIFIER_BUILD_ARGS_INVALID");
  }
  const output = canonicalAbsolutePath(args[1], "RC_VERIFIER_OUTPUT");
  if (basename(output) !== appName) throw new Error("RC_VERIFIER_OUTPUT_NAME_INVALID");
  return Object.freeze({ mode: args[0].slice(2), output });
}

async function assertMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("RC_VERIFIER_OUTPUT_EXISTS");
}

function requiredEnvironment(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}

function formalEnvironment(env) {
  for (const name of forbiddenCredentialEnvironment) {
    if (env[name] !== undefined) throw new Error(`${name}_FORBIDDEN`);
  }
  const identity = requiredEnvironment(env, "LAUNDRY_RC_CODESIGN_IDENTITY");
  const match = identity.match(
    /^Developer ID Application: [A-Za-z0-9][A-Za-z0-9 ._()-]{0,127} \(([A-Z0-9]{10})\)$/u,
  );
  if (match?.[1] === undefined) throw new Error("RC_CODESIGN_IDENTITY_INVALID");
  const profile = requiredEnvironment(env, "LAUNDRY_RC_NOTARY_PROFILE");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)) {
    throw new Error("RC_NOTARY_PROFILE_INVALID");
  }
  return Object.freeze({
    identity,
    keychain: canonicalAbsolutePath(
      requiredEnvironment(env, "LAUNDRY_RC_APPLE_KEYCHAIN"),
      "RC_APPLE_KEYCHAIN",
    ),
    profile,
    team: match[1],
  });
}

async function productVersion() {
  let value;
  try {
    value = JSON.parse(
      await readFile(join(repositoryRoot, "apps/edge-agent/package.json"), "utf8"),
    );
  } catch {
    throw new Error("RC_PRODUCT_VERSION_INVALID");
  }
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value.version)) {
    throw new Error("RC_PRODUCT_VERSION_INVALID");
  }
  return value.version;
}

function infoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>${executableName}</string>
  <key>CFBundleIdentifier</key><string>com.laundry-desk.release-candidate-verifier</string>
  <key>CFBundleName</key><string>${executableName}</string>
  <key>CFBundleDisplayName</key><string>${executableName}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
`;
}

async function run(file, args, options = {}) {
  return await execute(file, args, {
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
  });
}

async function signAndNotarize(appPath, mode, formal, workRoot) {
  if (mode === "testing") {
    await run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", appPath]);
    return;
  }
  const environment = Object.fromEntries(
    ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "TMPDIR", "USER"].flatMap((name) =>
      typeof process.env[name] === "string" ? [[name, process.env[name]]] : [],
    ),
  );
  await run(
    "/usr/bin/codesign",
    [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--sign",
      formal.identity,
      "--keychain",
      formal.keychain,
      appPath,
    ],
    { env: environment },
  );
  const upload = join(workRoot, "verifier-notary.zip");
  await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", appPath, upload], { env: environment });
  await run(
    "/usr/bin/xcrun",
    [
      "notarytool",
      "submit",
      upload,
      "--wait",
      "--keychain",
      formal.keychain,
      "--keychain-profile",
      formal.profile,
    ],
    { env: environment, maxBuffer: 4 * 1024 * 1024 },
  );
  await run("/usr/bin/xcrun", ["stapler", "staple", appPath], { env: environment });
  const inspected = await inspectFormalApp(appPath, {
    bundleIdentifier: "com.laundry-desk.release-candidate-verifier",
    version: await productVersion(),
  });
  if (inspected.teamIdentifier !== formal.team) throw new Error("RC_TEAM_IDENTIFIER_MISMATCH");
}

export async function buildVerifier(rawOptions, dependencies = {}) {
  const options = Object.freeze({ ...rawOptions });
  if (!["formal", "testing"].includes(options.mode))
    throw new Error("RC_VERIFIER_BUILD_OPTIONS_INVALID");
  canonicalAbsolutePath(options.output, "RC_VERIFIER_OUTPUT");
  if (basename(options.output) !== appName) throw new Error("RC_VERIFIER_OUTPUT_NAME_INVALID");
  await assertMissing(options.output);
  const formal =
    options.mode === "formal" ? formalEnvironment(dependencies.env ?? process.env) : null;
  const version = await productVersion();
  const parent = dirname(options.output);
  await ensureRealDirectory(parent, "RC_VERIFIER_OUTPUT_PARENT");
  const workRoot = await mkdtemp(join(parent, ".release-candidate-verifier-"));
  const appPath = join(workRoot, appName);
  const macOS = join(appPath, "Contents/MacOS");
  const executable = join(macOS, executableName);
  const slices = join(workRoot, "slices");
  try {
    await mkdir(macOS, { recursive: true, mode: 0o755 });
    await mkdir(slices, { mode: 0o700 });
    const sources = (await readdir(join(toolRoot, "Sources")))
      .filter((name) => name.endsWith(".swift"))
      .sort()
      .map((name) => join(toolRoot, "Sources", name));
    const outputs = [];
    for (const architecture of architectures) {
      const output = join(slices, `verifier.${architecture}`);
      outputs.push(output);
      await (dependencies.execute ?? run)("/usr/bin/xcrun", [
        "swiftc",
        "-O",
        "-target",
        `${architecture}-apple-macos13.0`,
        ...(options.mode === "testing" ? ["-D", "RUNTIME_TESTING"] : []),
        ...sources,
        "-framework",
        "CryptoKit",
        "-framework",
        "Foundation",
        "-o",
        output,
      ]);
    }
    await (dependencies.execute ?? run)("/usr/bin/lipo", [
      "-create",
      ...outputs,
      "-output",
      executable,
    ]);
    await writeFile(join(appPath, "Contents/Info.plist"), infoPlist(version), { mode: 0o644 });
    await signAndNotarize(appPath, options.mode, formal, workRoot);
    const archs = (await run("/usr/bin/lipo", ["-archs", executable])).stdout
      .trim()
      .split(/\s+/u)
      .sort();
    if (JSON.stringify(archs) !== JSON.stringify(architectures))
      throw new Error("RC_VERIFIER_NOT_UNIVERSAL");
    await rename(appPath, options.output);
    return Object.freeze({
      assurance: options.mode === "formal" ? "formal" : "software_only",
      output: options.output,
      version,
    });
  } catch (error) {
    await rm(workRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await buildVerifier(options);
  process.stdout.write(`${canonicalJson({ ok: true, ...result })}\n`);
}

const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "RC_VERIFIER_BUILD_FAILED";
    process.stderr.write(`${message.startsWith("RC_") ? message : "RC_VERIFIER_BUILD_FAILED"}\n`);
    process.exitCode = 1;
  });
}
