import { existsSync } from "node:fs";

export type ShellHealth = {
  spaRootExists: boolean;
  manifestExists: boolean;
  ok: boolean;
  checkedAt: number;
};

export function checkShellHealth(paths: { spaRoot: string; manifestPath: string }): ShellHealth {
  const spaRootExists = existsSync(paths.spaRoot);
  const manifestExists = existsSync(paths.manifestPath);
  return {
    spaRootExists,
    manifestExists,
    ok: spaRootExists && manifestExists,
    checkedAt: Date.now(),
  };
}
