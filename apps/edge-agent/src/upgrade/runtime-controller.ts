import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { KeyObject } from "node:crypto";
import { PrinterQueueNameSchema } from "@laundry/contracts";

import type { QueueStatusSnapshot } from "../queue/types.js";
import {
  evaluateReleaseRollback,
  verifyReleaseManifest,
  type ReleaseVerificationContext,
} from "./release-manifest.js";
import type { RuntimeUpdateIo } from "./runtime-io.js";
import {
  RUNTIME_RECOVERY_CAPABILITIES,
  RuntimeUpdateStateStore,
  type RuntimeRecoveryCapabilities,
  type RuntimeSlotName,
} from "./runtime-state.js";

const execFileAsync = promisify(execFile);
export const STAGED_HEALTH_ARGUMENT = "--laundry-staged-health-check";
export const ACTIVATION_ARGUMENT_PREFIX = "--laundry-activation=";

export type RuntimeUpdateResult =
  | Readonly<{ status: "no_update"; reason: string }>
  | Readonly<{ status: "blocked"; reason: string }>
  | Readonly<{
      status: "staged";
      version: string;
      slot: RuntimeSlotName;
      appPath: string;
    }>
  | Readonly<{ status: "failed"; reason: string }>;

export type StartupAction =
  | Readonly<{ action: "continue"; pendingConfirmation: null }>
  | Readonly<{
      action: "continue";
      pendingConfirmation: Readonly<{ slot: RuntimeSlotName; nonce: string }>;
    }>
  | Readonly<{ action: "launch"; appPath: string; activationNonce: string | null }>
  | Readonly<{ action: "recovery"; capabilities: RuntimeRecoveryCapabilities }>;

export type RuntimeUpdateControllerOptions = Readonly<{
  manifestUrl: string;
  publicKey: KeyObject;
  context: ReleaseVerificationContext;
  state: RuntimeUpdateStateStore;
  io: RuntimeUpdateIo;
  queueStatus: () => QueueStatusSnapshot;
  stagedHealth: (appPath: string) => Promise<boolean>;
  setPrimaryLeaseBlocked?: (blocked: boolean) => void;
  now?: () => string;
  randomId?: () => string;
}>;

export function prepareRuntimeStartup(
  state: RuntimeUpdateStateStore,
  currentAppPath: string,
  activationNonce: string | null,
  now: () => string = () => new Date().toISOString(),
): StartupAction {
  const snapshot = state.snapshot();
  const pending = snapshot.pending_activation;
  if (pending === null) {
    const activePath = snapshot.slots[snapshot.active_slot].app_path;
    return activePath !== null && activePath !== currentAppPath
      ? Object.freeze({ action: "launch", appPath: activePath, activationNonce: null })
      : Object.freeze({ action: "continue", pendingConfirmation: null });
  }
  const pendingPath = snapshot.slots[pending.slot].app_path;
  if (
    pendingPath === currentAppPath &&
    pending.launch_started &&
    activationNonce === pending.nonce
  ) {
    return Object.freeze({
      action: "continue",
      pendingConfirmation: Object.freeze({ slot: pending.slot, nonce: pending.nonce }),
    });
  }
  if (!pending.launch_started && pendingPath !== null && currentAppPath !== pendingPath) {
    state.markActivationLaunched(pending.nonce);
    return Object.freeze({
      action: "launch",
      appPath: pendingPath,
      activationNonce: pending.nonce,
    });
  }
  const rollback = state.rollbackPending(now());
  if (rollback.status === "recovery_required") {
    return Object.freeze({
      action: "recovery",
      capabilities: RUNTIME_RECOVERY_CAPABILITIES,
    });
  }
  const fallbackPath = rollback.state.slots[rollback.state.active_slot].app_path;
  return fallbackPath !== null && fallbackPath !== currentAppPath
    ? Object.freeze({ action: "launch", appPath: fallbackPath, activationNonce: null })
    : Object.freeze({ action: "continue", pendingConfirmation: null });
}

export class RuntimeUpdateController {
  private readonly now: () => string;
  private readonly randomId: () => string;

  constructor(private readonly options: RuntimeUpdateControllerOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.randomId = options.randomId ?? randomUUID;
  }

  async checkAndStage(): Promise<RuntimeUpdateResult> {
    const queue = this.options.queueStatus();
    if (queue.pendingCount !== 0 || queue.inflightCount !== 0) {
      return Object.freeze({ status: "blocked", reason: "offline_queue_not_empty" });
    }
    let leaseBlocked = false;
    let retainLeaseBlock = false;
    let releaseRoot: string | null = null;
    try {
      const candidate = await this.options.io.fetchManifest(this.options.manifestUrl);
      const verified = verifyReleaseManifest(
        candidate,
        this.options.publicKey,
        this.options.context,
      );
      if (!verified.ok) {
        return Object.freeze({
          status: verified.error === "UPDATE_VERSION_NOT_NEWER" ? "no_update" : "failed",
          reason: verified.error,
        });
      }
      const zip = verified.manifest.authority.artifacts.find((artifact) => artifact.kind === "zip");
      if (zip === undefined) {
        return Object.freeze({ status: "failed", reason: "UPDATE_ZIP_MISSING" });
      }
      const active = this.options.state.snapshot();
      const rollbackVersion = active.slots[active.active_slot].version;
      if (rollbackVersion === null) {
        return Object.freeze({ status: "failed", reason: "UPDATE_ROLLBACK_SLOT_EMPTY" });
      }
      const rollback = evaluateReleaseRollback(
        verified.manifest.authority,
        rollbackVersion,
        this.options.context.current_local_schema,
        active.minimum_secure_version,
      );
      if (!rollback.allowed) {
        return Object.freeze({ status: "failed", reason: rollback.reason });
      }
      this.options.setPrimaryLeaseBlocked?.(true);
      leaseBlocked = true;
      const queueAfterLeaseBlock = this.options.queueStatus();
      if (queueAfterLeaseBlock.pendingCount !== 0 || queueAfterLeaseBlock.inflightCount !== 0) {
        return Object.freeze({ status: "blocked", reason: "offline_queue_not_empty" });
      }
      const slot = this.options.state.standbySlot();
      const slotRoot = this.options.state.slotRoot(slot);
      releaseRoot = join(slotRoot, `${verified.manifest.authority.version}-${this.randomId()}`);
      await mkdir(releaseRoot, { mode: 0o700 });
      const downloaded = await this.options.io.downloadArtifact(
        this.options.manifestUrl,
        verified.manifest.authority,
        zip.name,
        releaseRoot,
      );
      const appPath = await this.options.io.extractAndVerifyMacApp(downloaded.path, releaseRoot);
      if (!(await this.options.stagedHealth(appPath))) {
        return Object.freeze({ status: "failed", reason: "UPDATE_STAGED_HEALTH_FAILED" });
      }
      this.options.state.activate({
        slot,
        version: verified.manifest.authority.version,
        appPath,
        artifactSha256: downloaded.sha256,
        nonce: this.randomId(),
        now: this.now(),
        minimumSecureVersion: verified.manifest.authority.minimum_secure_version,
      });
      retainLeaseBlock = true;
      return Object.freeze({
        status: "staged",
        version: verified.manifest.authority.version,
        slot,
        appPath,
      });
    } catch (error) {
      return Object.freeze({
        status: "failed",
        reason: error instanceof Error ? error.message : "UPDATE_RUNTIME_FAILED",
      });
    } finally {
      if (releaseRoot !== null && !retainLeaseBlock) {
        await rm(releaseRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      if (leaseBlocked && !retainLeaseBlock) {
        this.options.setPrimaryLeaseBlocked?.(false);
      }
    }
  }

  prepareStartup(currentAppPath: string, activationNonce: string | null): StartupAction {
    return prepareRuntimeStartup(this.options.state, currentAppPath, activationNonce, this.now);
  }

  confirmStartup(confirmation: Readonly<{ slot: RuntimeSlotName; nonce: string }>): void {
    this.options.state.confirmActivation(confirmation.slot, confirmation.nonce, this.now());
  }
}

export function macAppBundlePath(executablePath: string): string {
  if (!isAbsolute(executablePath)) throw new Error("Executable path must be absolute");
  const marker = ".app/Contents/MacOS/";
  const index = executablePath.indexOf(marker);
  if (index < 0) throw new Error("Executable is not inside a macOS app bundle");
  return executablePath.slice(0, index + ".app".length);
}

export function activationNonceFromArguments(arguments_: readonly string[]): string | null {
  const values = arguments_
    .filter((argument) => argument.startsWith(ACTIVATION_ARGUMENT_PREFIX))
    .map((argument) => argument.slice(ACTIVATION_ARGUMENT_PREFIX.length));
  return values.length === 1 && /^[0-9a-f-]{36}$/iu.test(values[0]!) ? values[0]! : null;
}

export function launchMacApp(appPath: string, activationNonce: string | null): void {
  const arguments_ = [
    "-n",
    appPath,
    ...(activationNonce === null
      ? []
      : ["--args", `${ACTIVATION_ARGUMENT_PREFIX}${activationNonce}`]),
  ];
  const child = spawn("/usr/bin/open", arguments_, {
    detached: true,
    stdio: "ignore",
    shell: false,
  });
  child.unref();
}

async function readSigningTeam(appPath: string): Promise<string> {
  const result = await execFileAsync("/usr/bin/codesign", ["-d", "--verbose=4", appPath], {
    timeout: 30_000,
    maxBuffer: 256 * 1_024,
  });
  const match = /^TeamIdentifier=([A-Z0-9]{10})$/mu.exec(result.stderr);
  if (match === null) throw new Error("macOS app has no Developer ID team");
  return match[1]!;
}

export async function validateMacAppLaunch(
  currentAppPath: string,
  targetAppPath: string,
): Promise<void> {
  if (
    !isAbsolute(currentAppPath) ||
    !isAbsolute(targetAppPath) ||
    !currentAppPath.endsWith(".app") ||
    !targetAppPath.endsWith(".app")
  ) {
    throw new Error("macOS launch paths must be absolute app bundles");
  }
  await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", targetAppPath], {
    timeout: 60_000,
    maxBuffer: 256 * 1_024,
  });
  await execFileAsync("/usr/sbin/spctl", ["--assess", "--type", "execute", targetAppPath], {
    timeout: 60_000,
    maxBuffer: 256 * 1_024,
  });
  const [currentTeam, targetTeam] = await Promise.all([
    readSigningTeam(currentAppPath),
    readSigningTeam(targetAppPath),
  ]);
  if (currentTeam !== targetTeam) throw new Error("Update app signing team does not match");
}

export async function runMacStagedHealth(appPath: string): Promise<boolean> {
  if (!isAbsolute(appPath) || !appPath.endsWith(".app")) return false;
  const executableRoot = join(appPath, "Contents", "MacOS");
  const entries = await readdir(executableRoot);
  if (entries.length !== 1) return false;
  const executable = join(executableRoot, entries[0]!);
  const metadata = await lstat(executable);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
  try {
    await validateMacAppLaunch(macAppBundlePath(process.execPath), appPath);
    const printerQueue = process.env.LAUNDRY_PRINTER_QUEUE ?? process.env.LAUNDRY_CUPS_QUEUE;
    const parsedQueue = PrinterQueueNameSchema.safeParse(printerQueue?.trim());
    const safeQueue = parsedQueue.success ? parsedQueue.data : undefined;
    const result = await execFileAsync(executable, [STAGED_HEALTH_ARGUMENT], {
      timeout: 30_000,
      maxBuffer: 64 * 1_024,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
        ...(safeQueue === undefined ? {} : { LAUNDRY_PRINTER_QUEUE: safeQueue }),
      },
    });
    return result.stdout.trim() === '{"ok":true}' && basename(appPath).endsWith(".app");
  } catch {
    return false;
  }
}
