import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const kitRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(kitRoot, "../..");
const testing = process.argv.slice(2).includes("--testing");
if (process.argv.slice(2).some((value) => value !== "--testing")) {
  throw new Error("RUNTIME_BUILD_ARGS_INVALID");
}

const outputName = testing ? "Laundry Desk Runtime Test.app" : "Laundry Desk Runtime.app";
const appRoot = join(kitRoot, "dist", outputName);
const contents = join(appRoot, "Contents");
const macOS = join(contents, "MacOS");
const resources = join(contents, "Resources");
const executable = join(macOS, "Laundry Desk Runtime");

await rm(appRoot, { recursive: true, force: true });
await mkdir(macOS, { recursive: true });
await mkdir(resources, { recursive: true });

const sourceRoot = join(kitRoot, "Sources");
const sources = (await readdir(sourceRoot))
  .filter((name) => name.endsWith(".swift"))
  .sort()
  .map((name) => join(sourceRoot, name));
const compilerArguments = [
  "swiftc",
  "-O",
  "-target",
  "arm64-apple-macos13.0",
  ...(testing ? ["-D", "RUNTIME_TESTING"] : []),
  ...sources,
  "-framework",
  "AppKit",
  "-framework",
  "SwiftUI",
  "-framework",
  "CryptoKit",
  "-framework",
  "Security",
  "-o",
  executable,
];
await execute("/usr/bin/xcrun", compilerArguments, {
  cwd: repositoryRoot,
  maxBuffer: 2 * 1024 * 1024,
});

await cp(
  join(repositoryRoot, "tools/compose/docker-compose.runtime.yml"),
  join(resources, "docker-compose.runtime.yml"),
);
if (testing) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  await writeFile(
    join(resources, "trusted-manifest-public-key.txt"),
    `${spki.subarray(spki.length - 32).toString("base64url")}\n`,
    { mode: 0o644 },
  );
  await writeFile(
    join(kitRoot, "dist/test-signing-private.pem"),
    privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
} else {
  await cp(
    join(kitRoot, "Resources/trusted-manifest-public-key.txt"),
    join(resources, "trusted-manifest-public-key.txt"),
  );
}
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Laundry Desk Runtime</string>
  <key>CFBundleIdentifier</key><string>com.laundry-desk.runtime</string>
  <key>CFBundleName</key><string>Laundry Desk Runtime</string>
  <key>CFBundleDisplayName</key><string>Laundry Desk Runtime</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
await writeFile(join(contents, "Info.plist"), plist, { mode: 0o644 });
await execute("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", appRoot], {
  maxBuffer: 512 * 1024,
});

const copiedCompose = await readFile(join(resources, "docker-compose.runtime.yml"));
if (copiedCompose.length === 0) throw new Error("RUNTIME_BUILD_RESOURCE_MISSING");
process.stdout.write(`${appRoot}\n`);
