import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { dataToolErrorCode, LocalDataError } from "./data-tools.mjs";
import { unwrapPackageManagerArguments } from "./compose.mjs";

const LABEL = "com.laundry-desk.v2.maintenance";

export function parseLaunchdArguments(argv) {
  const args = unwrapPackageManagerArguments(argv);
  if (args.length !== 1 || args[0] !== "--install") {
    throw new LocalDataError("LOCAL_MAINTENANCE_SCHEDULE_ARGS_INVALID");
  }
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildMaintenancePlist(options) {
  for (const value of [
    options.nodePath,
    options.dockerPath,
    options.scriptPath,
    options.cwd,
    options.logPath,
  ]) {
    if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
      throw new LocalDataError("LOCAL_MAINTENANCE_SCHEDULE_PATH_INVALID");
    }
  }
  const executablePath = [
    dirname(options.dockerPath),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
    .filter((value, index, paths) => paths.indexOf(value) === index)
    .join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(options.nodePath)}</string>
    <string>${xml(options.scriptPath)}</string>
    <string>--apply-retention</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(options.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(executablePath)}</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${xml(options.logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(options.logPath)}</string>
</dict>
</plist>
`;
}

function capture(file, args) {
  return new Promise((resolveRun, rejectRun) => {
    nodeExecFile(file, args, { shell: false }, (error) => {
      if (error === null) resolveRun();
      else
        rejectRun(new LocalDataError("LOCAL_MAINTENANCE_SCHEDULE_LOAD_FAILED", { cause: error }));
    });
  });
}

function resolveDockerPath() {
  return new Promise((resolvePath, rejectPath) => {
    nodeExecFile(
      "/usr/bin/which",
      ["docker"],
      { shell: false, encoding: "utf8" },
      (error, stdout) => {
        const path = stdout.trim();
        if (error === null && isAbsolute(path) && resolve(path) === path) {
          resolvePath(path);
        } else {
          rejectPath(
            new LocalDataError("LOCAL_MAINTENANCE_SCHEDULE_DOCKER_UNAVAILABLE", { cause: error }),
          );
        }
      },
    );
  });
}

export async function installMaintenanceLaunchAgent(
  options,
  dependencies = Object.freeze({
    platform: process.platform,
    homeDir: homedir(),
    nodePath: process.execPath,
    mkdir,
    lstat,
    open,
    rename,
    unlink,
    randomUUID,
    capture,
    resolveDockerPath,
    uid: process.getuid?.(),
  }),
) {
  parseLaunchdArguments(options.argv);
  if (dependencies.platform !== "darwin" || !Number.isSafeInteger(dependencies.uid)) {
    throw new LocalDataError("LOCAL_MAINTENANCE_SCHEDULE_PLATFORM_UNSUPPORTED");
  }
  const cwd = resolve(options.cwd);
  const scriptPath = join(cwd, "tools", "local", "maintenance.mjs");
  const launchAgents = join(dependencies.homeDir, "Library", "LaunchAgents");
  await dependencies.mkdir(launchAgents, { recursive: true, mode: 0o755 });
  const path = join(launchAgents, `${LABEL}.plist`);
  const existing = await dependencies.lstat(path).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new LocalDataError("LOCAL_MAINTENANCE_SCHEDULE_PATH_INVALID");
  }
  const logPath = join(dependencies.homeDir, "Library", "Logs", "laundry-desk-maintenance.log");
  await dependencies.mkdir(join(dependencies.homeDir, "Library", "Logs"), {
    recursive: true,
    mode: 0o755,
  });
  const dockerPath = await dependencies.resolveDockerPath();
  const temporary = `${path}.${dependencies.randomUUID()}.tmp`;
  const handle = await dependencies.open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(
      buildMaintenancePlist({
        nodePath: dependencies.nodePath,
        dockerPath,
        scriptPath,
        cwd,
        logPath,
      }),
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  await dependencies.rename(temporary, path);
  const domain = `gui/${dependencies.uid}`;
  await dependencies.capture("launchctl", ["bootout", domain, path]).catch(() => undefined);
  await dependencies.capture("launchctl", ["bootstrap", domain, path]);
  options.stdout(`Installed daily 03:00 maintenance: ${path}\n`);
  return Object.freeze({ path, label: LABEL });
}

const isMainModule = () => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};

if (isMainModule()) {
  void installMaintenanceLaunchAgent({
    argv: Object.freeze(process.argv.slice(2)),
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
  }).catch((error) => {
    process.stderr.write(`${dataToolErrorCode(error, "LOCAL_MAINTENANCE_SCHEDULE_FAILED")}\n`);
    process.exitCode = 1;
  });
}
