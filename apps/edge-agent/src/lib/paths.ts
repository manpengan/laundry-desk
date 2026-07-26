import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeSpaPathOptions = Readonly<{
  isPackaged: boolean;
  packageRoot: string;
  resourcesPath: string;
}>;

/** Package root (`apps/edge-agent`) whether running from src layout or dist/. */
export function packageRootFromModuleUrl(moduleUrl: string): string {
  const here = dirname(fileURLToPath(moduleUrl));
  // dist/*.js → package root is parent; src layout never used at runtime for main
  return join(here, "..");
}

export function spaRootFromPackageRoot(packageRoot: string): string {
  return join(packageRoot, "resources", "spa");
}

/** Resolve the verified SPA without consulting the frozen root v1 application. */
export function spaRootForRuntime(options: RuntimeSpaPathOptions): string {
  return options.isPackaged
    ? join(options.resourcesPath, "spa")
    : spaRootFromPackageRoot(options.packageRoot);
}

export function manifestPathFromSpaRoot(spaRoot: string): string {
  return join(spaRoot, "manifest.json");
}

export function preloadPathFromDistDir(distDir: string): string {
  return join(distDir, "preload.cjs");
}
