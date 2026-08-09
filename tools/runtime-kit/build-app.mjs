import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const kitRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(kitRoot, "../..");

export const RUNTIME_APP_VERSION = "0.1.0";
export const RUNTIME_APP_BUILD_VERSION = "1";
export const RUNTIME_ARCHITECTURES = Object.freeze(["arm64", "x86_64"]);

export function parseRuntimeBuildArguments(arguments_) {
  const argumentsList = [...arguments_];
  if (argumentsList.length === 0) return Object.freeze({ release: false, testing: false });
  if (argumentsList.length === 1 && argumentsList[0] === "--testing") {
    return Object.freeze({ release: false, testing: true });
  }
  if (
    argumentsList.length === 5 &&
    argumentsList[0] === "--testing" &&
    argumentsList[1] === "--testing-signing-key-output" &&
    argumentsList[3] === "--testing-output-root"
  ) {
    return Object.freeze({
      release: false,
      testing: true,
      testingSigningKeyPath: argumentsList[2],
      testingOutputRoot: argumentsList[4],
    });
  }
  if (argumentsList.length === 1 && argumentsList[0] === "--release") {
    return Object.freeze({ release: true, testing: false });
  }
  throw new Error("RUNTIME_BUILD_ARGS_INVALID");
}

function compilerArguments(architecture, sources, output, testing) {
  return [
    "swiftc",
    "-O",
    "-target",
    `${architecture}-apple-macos13.0`,
    ...(testing ? ["-D", "RUNTIME_TESTING"] : []),
    ...sources,
    "-framework",
    "AppKit",
    "-framework",
    "SwiftUI",
    "-framework",
    "CryptoKit",
    "-framework",
    "CoreImage",
    "-framework",
    "Security",
    "-o",
    output,
  ];
}

async function assertPrivateTestingDirectory(path, failureCode) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error(failureCode);
  }
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error(failureCode);
  }
  let canonicalPath;
  try {
    canonicalPath = await realpath(path);
  } catch {
    throw new Error(failureCode);
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
    canonicalPath !== path
  ) {
    throw new Error(failureCode);
  }
  return path;
}

async function assertPrivateTestingKeyOutput(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error("RUNTIME_BUILD_TESTING_KEY_PATH_INVALID");
  }
  await assertPrivateTestingDirectory(dirname(path), "RUNTIME_BUILD_TESTING_KEY_PATH_INVALID");
  try {
    await lstat(path);
    throw new Error("RUNTIME_BUILD_TESTING_KEY_PREEXISTS");
  } catch (error) {
    if (error instanceof Error && error.message === "RUNTIME_BUILD_TESTING_KEY_PREEXISTS") {
      throw error;
    }
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error("RUNTIME_BUILD_TESTING_KEY_PATH_INVALID");
    }
  }
  return path;
}

async function assertPrivateTestingOutputRoot(path) {
  await assertPrivateTestingDirectory(path, "RUNTIME_BUILD_TESTING_OUTPUT_ROOT_INVALID");
  const appRoot = join(path, "Laundry Desk Runtime Test.app");
  try {
    await lstat(appRoot);
    throw new Error("RUNTIME_BUILD_TESTING_APP_PREEXISTS");
  } catch (error) {
    if (error instanceof Error && error.message === "RUNTIME_BUILD_TESTING_APP_PREEXISTS") {
      throw error;
    }
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error("RUNTIME_BUILD_TESTING_OUTPUT_ROOT_INVALID");
    }
  }
  return appRoot;
}

export async function copyTrustedKey(resources, options) {
  if (options.testing) {
    const privateKeyPath =
      options.testingSigningKeyPath !== undefined
        ? await assertPrivateTestingKeyOutput(options.testingSigningKeyPath)
        : join(kitRoot, "dist/test-signing-private.pem");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" });
    await writeFile(
      join(resources, "trusted-manifest-public-key.txt"),
      `${spki.subarray(spki.length - 32).toString("base64url")}\n`,
      { mode: 0o644 },
    );
    if (options.testingSigningKeyPath === undefined) {
      await rm(privateKeyPath, { force: true });
    }
    await writeFile(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }), {
      flag: "wx",
      mode: 0o600,
    });
    return;
  }
  const source = options.release
    ? join(kitRoot, "build/release/trusted-manifest-public-key.txt")
    : join(kitRoot, "Resources/trusted-manifest-public-key.txt");
  await cp(source, join(resources, "trusted-manifest-public-key.txt"));
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Laundry Desk Runtime</string>
  <key>CFBundleIdentifier</key><string>com.laundry-desk.runtime</string>
  <key>CFBundleName</key><string>Laundry Desk Runtime</string>
  <key>CFBundleDisplayName</key><string>Laundry Desk Runtime</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${RUNTIME_APP_VERSION}</string>
  <key>CFBundleVersion</key><string>${RUNTIME_APP_BUILD_VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
}

export async function buildRuntimeApp(options, dependencies = {}) {
  const isolatedTestingBuild =
    options?.testingSigningKeyPath !== undefined || options?.testingOutputRoot !== undefined;
  if (
    typeof options?.testing !== "boolean" ||
    typeof options?.release !== "boolean" ||
    (options.testing && options.release) ||
    (isolatedTestingBuild &&
      (!options.testing ||
        typeof options.testingSigningKeyPath !== "string" ||
        typeof options.testingOutputRoot !== "string"))
  ) {
    throw new Error("RUNTIME_BUILD_OPTIONS_INVALID");
  }
  if (options.testingSigningKeyPath !== undefined) {
    await assertPrivateTestingKeyOutput(options.testingSigningKeyPath);
  }
  if (
    isolatedTestingBuild &&
    relative(dirname(options.testingSigningKeyPath), options.testingOutputRoot) !== "runtime-app"
  ) {
    throw new Error("RUNTIME_BUILD_TESTING_OUTPUT_ROOT_INVALID");
  }
  const privateAppRoot =
    options.testingOutputRoot !== undefined
      ? await assertPrivateTestingOutputRoot(options.testingOutputRoot)
      : null;
  const run = dependencies.execute ?? execute;
  const outputName = options.testing ? "Laundry Desk Runtime Test.app" : "Laundry Desk Runtime.app";
  const appRoot = privateAppRoot ?? join(kitRoot, "dist", outputName);
  const contents = join(appRoot, "Contents");
  const macOS = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  const executable = join(macOS, "Laundry Desk Runtime");
  const buildRoot = privateAppRoot === null ? join(kitRoot, "build") : options.testingOutputRoot;

  if (privateAppRoot === null) {
    await rm(appRoot, { recursive: true, force: true });
  } else {
    try {
      await mkdir(appRoot, { mode: 0o700 });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error("RUNTIME_BUILD_TESTING_APP_PREEXISTS");
      }
      throw error;
    }
  }
  await mkdir(macOS, { recursive: true });
  await mkdir(resources, { recursive: true });
  await mkdir(buildRoot, { recursive: true, mode: 0o700 });
  const architectureRoot = await mkdtemp(join(buildRoot, "architectures-"));

  const sourceRoot = join(kitRoot, "Sources");
  const sources = (await readdir(sourceRoot))
    .filter((name) => name.endsWith(".swift"))
    .sort()
    .map((name) => join(sourceRoot, name));
  const architectureExecutables = RUNTIME_ARCHITECTURES.map((architecture) =>
    join(architectureRoot, `Laundry Desk Runtime.${architecture}`),
  );
  try {
    for (const [index, architecture] of RUNTIME_ARCHITECTURES.entries()) {
      const output = architectureExecutables[index];
      if (output === undefined) throw new Error("RUNTIME_BUILD_ARCHITECTURE_INVALID");
      await run(
        "/usr/bin/xcrun",
        compilerArguments(architecture, sources, output, options.testing),
        { cwd: repositoryRoot, maxBuffer: 2 * 1024 * 1024 },
      );
    }
    await run("/usr/bin/lipo", ["-create", ...architectureExecutables, "-output", executable], {
      cwd: repositoryRoot,
      maxBuffer: 512 * 1024,
    });
  } finally {
    await rm(architectureRoot, { recursive: true, force: true });
  }

  await cp(
    join(repositoryRoot, "tools/compose/docker-compose.runtime.yml"),
    join(resources, "docker-compose.runtime.yml"),
  );
  await cp(
    join(repositoryRoot, "tools/compose/docker-compose.runtime-lan.yml"),
    join(resources, "docker-compose.runtime-lan.yml"),
  );
  await copyTrustedKey(resources, options);
  await writeFile(join(contents, "Info.plist"), infoPlist(), { mode: 0o644 });
  await run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", appRoot], {
    maxBuffer: 512 * 1024,
  });

  const copiedCompose = await readFile(join(resources, "docker-compose.runtime.yml"));
  const copiedLanCompose = await readFile(join(resources, "docker-compose.runtime-lan.yml"));
  if (copiedCompose.length === 0 || copiedLanCompose.length === 0) {
    throw new Error("RUNTIME_BUILD_RESOURCE_MISSING");
  }
  return appRoot;
}

async function main() {
  const options = parseRuntimeBuildArguments(process.argv.slice(2));
  const appRoot = await buildRuntimeApp(options);
  process.stdout.write(`${appRoot}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  await main();
}
