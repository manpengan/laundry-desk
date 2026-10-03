import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { initializeWindowsBaseline } from "./windows-update-baseline.js";
import { prepareVerifiedStartup } from "./verified-startup.js";
import type { QueueStatusSnapshot } from "../queue/types.js";
import { createRuntimeUpdateIo, loadUpdatePublicKey } from "./runtime-io.js";
import { RuntimeUpdateStateStore } from "./runtime-state.js";
import { resolveUpdateConfiguration } from "./update-config.js";
import {
  ACTIVATION_ARGUMENT_PREFIX,
  STAGED_HEALTH_ARGUMENT,
  RuntimeUpdateController,
  activationNonceFromArguments,
  launchMacApp,
  macAppBundlePath,
  prepareRuntimeStartup,
  runMacStagedHealth,
  validateMacAppLaunch,
} from "./runtime-controller.js";
import {
  createWindowsUpdateIo,
  validateWindowsUpdateLaunch,
  windowsUpdateTarget,
} from "./windows-update-io.js";

const execFileAsync = promisify(execFile);
type Options = Readonly<{
  isPackaged: boolean;
  platform: NodeJS.Platform;
  version: string;
  resourcesPath: string;
  userData: string;
  executable: string;
  arguments: readonly string[];
  env: NodeJS.ProcessEnv;
  releaseInstanceLock: () => void;
}>;

async function runWindowsStagedHealth(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const inherited = Object.fromEntries(
    ["SystemRoot", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"].flatMap(
      (name) => (env[name] === undefined ? [] : [[name, env[name]!]]),
    ),
  );
  try {
    const result = await execFileAsync(executable, [STAGED_HEALTH_ARGUMENT], {
      shell: false,
      windowsHide: true,
      cwd: dirname(executable),
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      env: { ...inherited, PATH: "C:\\Windows\\System32" },
    });
    return result.stdout.trim() === '{"ok":true}';
  } catch {
    return false;
  }
}

function launchWindows(executable: string, nonce: string | null): void {
  const child = spawn(executable, nonce === null ? [] : [`${ACTIVATION_ARGUMENT_PREFIX}${nonce}`], {
    detached: true,
    stdio: "ignore",
    shell: false,
    cwd: dirname(executable),
  });
  child.on("error", () => {
    console.error("[edge-agent] update launch failed");
  });
  child.unref();
}

/** Coordinates platform-specific verification with the shared A/B and offline-queue guards. */
export async function prepareDesktopUpdate(options: Options) {
  const config = await resolveUpdateConfiguration(options);
  const supported =
    options.isPackaged &&
    (options.platform === "darwin" || (options.platform === "win32" && config.enabled));
  if (!supported)
    return Object.freeze({
      mode: "normal" as const,
      launch: null,
      confirm: () => {},
      check: async () => {},
    });
  const windows = options.platform === "win32";
  const current = windows ? options.executable : macAppBundlePath(options.executable);
  const updatesRoot = join(options.userData, "updates");
  const newState = !existsSync(join(updatesRoot, "update-state.json"));
  const state = new RuntimeUpdateStateStore(updatesRoot, {
    currentVersion: options.version,
    currentAppPath: current,
    minimumSecureVersion: options.version,
  });
  const publicKey = config.enabled
    ? await loadUpdatePublicKey(join(options.resourcesPath, "update", "update-public-key.pem"))
    : null;
  const target = windows ? await windowsUpdateTarget(options.resourcesPath) : undefined;
  const original = windows
    ? await initializeWindowsBaseline(state.root, current, newState)
    : current;
  const validate = async (appPath: string) => {
    if (windows && publicKey && target)
      await validateWindowsUpdateLaunch({
        currentExe: current,
        targetExe: appPath,
        updatesRoot: state.root,
        publicKey,
        target,
        minimumSecureVersion: state.snapshot().minimum_secure_version,
        originalExe: original,
      });
    else await validateMacAppLaunch(current, appPath);
  };
  const startup = windows
    ? await prepareVerifiedStartup(
        state,
        current,
        activationNonceFromArguments(options.arguments),
        validate,
      )
    : prepareRuntimeStartup(state, current, activationNonceFromArguments(options.arguments));
  if (startup.action === "launch") {
    if (!windows) await validate(startup.appPath);
    return Object.freeze({
      mode: "normal" as const,
      launch: () => {
        options.releaseInstanceLock();
        if (windows) launchWindows(startup.appPath, startup.activationNonce);
        else launchMacApp(startup.appPath, startup.activationNonce);
      },
      confirm: () => {},
      check: async () => {},
    });
  }
  const mode = startup.action === "recovery" ? ("recovery" as const) : ("normal" as const);
  return Object.freeze({
    mode,
    launch: null,
    confirm() {
      if (startup.action === "continue" && startup.pendingConfirmation) {
        state.confirmActivation(
          startup.pendingConfirmation.slot,
          startup.pendingConfirmation.nonce,
          new Date().toISOString(),
        );
      }
    },
    async check(
      queueStatus: () => QueueStatusSnapshot,
      setPrimaryLeaseBlocked: (blocked: boolean) => void,
    ) {
      if (!config.enabled || mode !== "normal" || !publicKey) return;
      const controller = new RuntimeUpdateController({
        manifestUrl: config.manifest_url,
        publicKey,
        state,
        context: {
          ...(target === undefined ? {} : { target }),
          channel: config.channel,
          current_version: options.version,
          installed_minimum_secure_version: state.snapshot().minimum_secure_version,
          current_local_schema: 3,
          supported_contracts_majors: [0],
        },
        io: windows ? createWindowsUpdateIo(current) : createRuntimeUpdateIo(),
        queueStatus,
        setPrimaryLeaseBlocked,
        stagedHealth: windows
          ? (path) => runWindowsStagedHealth(path, options.env)
          : runMacStagedHealth,
      });
      const result = await controller.checkAndStage();
      console.log(
        "[edge-agent] update check",
        result.status,
        "reason" in result ? result.reason : result.version,
      );
    },
  });
}
