import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type SpaManifest = {
  version: string;
  indexSha256: string;
  note?: string;
};

export function loadManifest(manifestPath: string): SpaManifest {
  const raw = readFileSync(manifestPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isSpaManifest(parsed)) {
    throw new Error("SPA manifest missing version or indexSha256");
  }
  return parsed;
}

export function isSpaManifest(value: unknown): value is SpaManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.version === "string" && typeof v.indexSha256 === "string";
}

/**
 * M1 stand-in: SHA-256 of index.html must match manifest.
 * Production (later) replaces this with detached asymmetric signature + cert pin.
 */
export function verifySpaIntegrity(spaRoot: string, manifest: SpaManifest): string {
  const indexPath = join(spaRoot, "index.html");
  const hash = createHash("sha256").update(readFileSync(indexPath)).digest("hex");
  if (hash !== manifest.indexSha256) {
    throw new Error(`SPA integrity failed: expected ${manifest.indexSha256}, got ${hash}`);
  }
  return hash;
}

export function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}
