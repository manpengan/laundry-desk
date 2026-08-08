import { isAbsolute, resolve } from "node:path";

import { buildSignedReleaseBundle, verifySignedReleaseBundle } from "./release-bundle.js";

function canonicalEnvironmentPath(value: string | undefined): string | null {
  return value !== undefined && isAbsolute(value) && resolve(value) === value ? value : null;
}

async function main(): Promise<void> {
  const releaseDirectory = canonicalEnvironmentPath(process.env.LAUNDRY_RELEASE_DIRECTORY);
  const descriptorText = process.env.LAUNDRY_RELEASE_INPUT_DESCRIPTOR;
  if (releaseDirectory === null || descriptorText === undefined || descriptorText.length > 16_384) {
    throw new Error("release directory and immutable input descriptor are required");
  }
  const descriptor = JSON.parse(descriptorText) as unknown;
  const publicKeyPath = canonicalEnvironmentPath(
    process.env.LAUNDRY_RELEASE_VERIFY_PUBLIC_KEY_FILE,
  );
  const updateConfigPath = canonicalEnvironmentPath(
    process.env.LAUNDRY_RELEASE_VERIFY_UPDATE_CONFIG_FILE,
  );
  if (publicKeyPath !== null || updateConfigPath !== null) {
    if (publicKeyPath === null || updateConfigPath === null) {
      throw new Error("release verification inputs must be complete");
    }
    await verifySignedReleaseBundle({
      releaseDirectory,
      publicKeyPath,
      updateConfigPath,
      descriptor,
    });
    process.stdout.write('{"ok":true,"verified":true}\n');
    return;
  }
  const privateKeyPath = canonicalEnvironmentPath(process.env.LAUNDRY_UPDATE_PRIVATE_KEY_FILE);
  const policyPath = canonicalEnvironmentPath(process.env.LAUNDRY_RELEASE_POLICY_FILE);
  if (privateKeyPath === null || policyPath === null) {
    throw new Error("release signing inputs must be canonical absolute paths");
  }
  const result = await buildSignedReleaseBundle({
    releaseDirectory,
    privateKeyPath,
    policyPath,
    descriptor,
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      manifest: result.path,
      version: result.manifest.authority.version,
      artifacts: result.manifest.authority.artifacts.map((artifact) => artifact.name),
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "release manifest generation failed";
  process.stderr.write(`[release-manifest] ${message}\n`);
  process.exitCode = 1;
});
