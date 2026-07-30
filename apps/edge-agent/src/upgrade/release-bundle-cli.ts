import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSignedReleaseBundle } from "./release-bundle.js";

async function main(): Promise<void> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const releaseDirectory = join(packageRoot, "release");
  const privateKeyPath = process.env.LAUNDRY_UPDATE_PRIVATE_KEY_FILE;
  const policyPath = process.env.LAUNDRY_RELEASE_POLICY_FILE;
  if (
    privateKeyPath === undefined ||
    policyPath === undefined ||
    !isAbsolute(privateKeyPath) ||
    !isAbsolute(policyPath)
  ) {
    throw new Error("release key and policy must be provided as absolute environment paths");
  }
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string") throw new Error("package version is unavailable");
  const result = await buildSignedReleaseBundle({
    releaseDirectory,
    version: packageJson.version,
    privateKeyPath,
    policyPath,
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
