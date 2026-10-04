import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { App } from "electron";

/** ADR-91 P1-7: the packaged name of the generic Windows distribution. */
export const GENERIC_WINDOWS_APP_NAME = "laundry-desk-v2";
/** Both Windows distributions shared this userData before each packaged its own name. */
const LEGACY_SHARED_USER_DATA = join("@laundry", "edge-agent");

type Files = Readonly<{
  existsSync: (path: string) => boolean;
  renameSync: (from: string, to: string) => void;
}>;

/**
 * Each Windows distribution now packages its own ASCII name, so userData, the
 * single-instance lock and the install directory no longer collide. The generic build
 * adopts the pre-split shared directory once, by a same-volume rename that keeps its
 * private ACLs and device identity; the hongfa build starts fresh and pairs again.
 * Must run before anything opens userData.
 */
export function adoptLegacyUserData(
  app: Pick<App, "getName" | "getPath">,
  platform: NodeJS.Platform = process.platform,
  files: Files = { existsSync, renameSync },
): "adopted" | "skipped" {
  if (platform !== "win32" || app.getName() !== GENERIC_WINDOWS_APP_NAME) return "skipped";
  const target = app.getPath("userData");
  const legacy = join(app.getPath("appData"), LEGACY_SHARED_USER_DATA);
  if (files.existsSync(target) || !files.existsSync(legacy)) return "skipped";
  files.renameSync(legacy, target);
  return "adopted";
}
