import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root (`apps/edge-agent`) whether running from src layout or dist/. */
export function packageRootFromModuleUrl(moduleUrl: string): string {
  const here = dirname(fileURLToPath(moduleUrl));
  // dist/*.js → package root is parent; src layout never used at runtime for main
  return join(here, "..");
}

export function spaRootFromPackageRoot(packageRoot: string): string {
  return join(packageRoot, "resources", "spa");
}

export function manifestPathFromSpaRoot(spaRoot: string): string {
  return join(spaRoot, "manifest.json");
}

export function preloadPathFromDistDir(distDir: string): string {
  return join(distDir, "preload.js");
}
