import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeUpdateResult, StartupAction } from "./runtime-controller.js";
import {
  createDrillHarness,
  DEFAULT_DRILL_OPTIONS,
  DRILL_ACTIVATION_ID,
  DRILL_ARTIFACT_NAME,
  DRILL_OLD_APP,
  DRILL_RELEASE_ID,
  reopenDrillState,
  type DrillHarness,
  type DrillOptions,
} from "./runtime-recovery-drill-fixture.js";

const SCENARIO_NAMES = [
  "tampered_signature",
  "pending_queue_before_network",
  "inflight_queue_before_network",
  "download_interrupted_cleanup",
  "digest_mismatch_cleanup",
  "extract_interrupted_cleanup",
  "team_mismatch_cleanup",
  "health_rejected_cleanup",
  "normal_stage_retains_release",
  "activate_crash_persists_pending",
  "launch_crash_rolls_back",
  "activation_confirmed",
  "security_floor_recovery",
] as const;

export type RuntimeRecoveryDrillScenario = (typeof SCENARIO_NAMES)[number];
export type RuntimeRecoveryDrillReport = Readonly<{
  ok: true;
  scenarios: readonly RuntimeRecoveryDrillScenario[];
}>;

export const RUNTIME_RECOVERY_DRILL_SCENARIOS: readonly RuntimeRecoveryDrillScenario[] =
  Object.freeze([...SCENARIO_NAMES]);

function requireDrill(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Runtime recovery drill failed: ${message}`);
}

function withOptions(overrides: Partial<DrillOptions>): DrillOptions {
  return Object.freeze({ ...DEFAULT_DRILL_OPTIONS, ...overrides });
}

function requireArrayEqual(
  actual: readonly string[] | readonly boolean[],
  expected: readonly string[] | readonly boolean[],
  message: string,
): void {
  requireDrill(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function requireStatus(
  result: RuntimeUpdateResult,
  status: RuntimeUpdateResult["status"],
  reason?: string,
): void {
  requireDrill(result.status === status, `expected ${status}, received ${result.status}`);
  if (reason !== undefined) {
    requireDrill(
      "reason" in result && result.reason === reason,
      `expected failure reason ${reason}`,
    );
  }
}

function requireLaunch(action: StartupAction, appPath: string): string {
  requireDrill(action.action === "launch", "expected pending update launch");
  requireDrill(action.appPath === appPath, "launch selected an unexpected app bundle");
  requireDrill(action.activationNonce !== null, "update launch omitted activation nonce");
  return action.activationNonce;
}

async function requireNoReleaseResidue(harness: DrillHarness): Promise<void> {
  requireArrayEqual(await harness.releaseEntries(), [], "failed update left slot residue");
}

async function stageSuccessfully(root: string): Promise<
  Readonly<{
    harness: DrillHarness;
    appPath: string;
    releaseRoot: string;
  }>
> {
  const harness = await createDrillHarness(root);
  const result = await harness.controller.checkAndStage();
  requireStatus(result, "staged");
  requireDrill(result.status === "staged", "staging result did not narrow");
  const releaseRoot = join(harness.root, "slots", "B", `2.0.0-${DRILL_RELEASE_ID}`);
  const appPath = join(releaseRoot, "payload", "laundry-desk V2.app");
  requireDrill(result.appPath === appPath, "staged app escaped its release root");
  requireArrayEqual(
    await harness.releaseEntries(),
    [`2.0.0-${DRILL_RELEASE_ID}`],
    "release missing",
  );
  requireArrayEqual(harness.leaseBlocks(), [true], "successful stage released primary lease");
  requireDrill(
    harness.fetchCount() === 2,
    "successful stage did not use manifest and artifact I/O",
  );
  return Object.freeze({ harness, appPath, releaseRoot });
}

async function runTamperedSignature(root: string): Promise<void> {
  const harness = await createDrillHarness(root, withOptions({ manifest: "tampered" }));
  requireStatus(await harness.controller.checkAndStage(), "failed", "UPDATE_SIGNATURE_INVALID");
  requireDrill(harness.fetchCount() === 1, "invalid signature downloaded an artifact");
  requireArrayEqual(harness.leaseBlocks(), [], "invalid signature changed primary lease");
  await requireNoReleaseResidue(harness);
}

async function runQueueBlock(root: string, queue: "pending" | "inflight"): Promise<void> {
  const options =
    queue === "pending" ? withOptions({ pendingCount: 1 }) : withOptions({ inflightCount: 1 });
  const harness = await createDrillHarness(root, options);
  requireStatus(await harness.controller.checkAndStage(), "blocked", "offline_queue_not_empty");
  requireDrill(harness.fetchCount() === 0, `${queue} queue reached update network`);
  requireArrayEqual(harness.leaseBlocks(), [], `${queue} queue changed primary lease`);
  await requireNoReleaseResidue(harness);
}

async function runFailedStage(
  root: string,
  options: DrillOptions,
  expectedReason: string,
): Promise<void> {
  const harness = await createDrillHarness(root, options);
  requireStatus(await harness.controller.checkAndStage(), "failed", expectedReason);
  requireDrill(harness.fetchCount() === 2, "post-manifest failure skipped production download I/O");
  requireArrayEqual(harness.leaseBlocks(), [true, false], "failed stage retained primary lease");
  await requireNoReleaseResidue(harness);
}

async function runNormalStage(root: string): Promise<void> {
  const staged = await stageSuccessfully(root);
  const entries = Object.freeze([...(await readdir(staged.releaseRoot))].sort());
  requireArrayEqual(
    entries,
    [DRILL_ARTIFACT_NAME, "payload"].sort(),
    "successful release root omitted atomic artifact or payload",
  );
  const artifact = await lstat(join(staged.releaseRoot, DRILL_ARTIFACT_NAME));
  requireDrill(
    artifact.isFile() && !artifact.isSymbolicLink(),
    "successful download was not an atomic real file",
  );
}

async function runActivateCrash(root: string): Promise<void> {
  const staged = await stageSuccessfully(root);
  const reopened = reopenDrillState(root);
  const snapshot = reopened.snapshot();
  requireDrill(snapshot.active_slot === "B", "activated slot was not persisted before crash");
  requireDrill(
    snapshot.pending_activation?.nonce === DRILL_ACTIVATION_ID &&
      snapshot.pending_activation.launch_started === false,
    "pending activation was not durably recoverable",
  );
  requireArrayEqual(
    await staged.harness.releaseEntries(),
    [`2.0.0-${DRILL_RELEASE_ID}`],
    "release lost",
  );
}

async function runLaunchCrash(root: string): Promise<void> {
  const staged = await stageSuccessfully(root);
  requireLaunch(staged.harness.controller.prepareStartup(DRILL_OLD_APP, null), staged.appPath);
  const afterCrash = reopenDrillState(root);
  const action = staged.harness.controllerFor(afterCrash).prepareStartup(DRILL_OLD_APP, null);
  requireDrill(
    action.action === "continue" && action.pendingConfirmation === null,
    "compatible interrupted launch did not return to installed app",
  );
  const persisted = reopenDrillState(root).snapshot();
  requireDrill(
    persisted.active_slot === "A" &&
      persisted.pending_activation === null &&
      persisted.slots.B.healthy === false,
    "compatible rollback was not persisted",
  );
}

async function runActivationConfirmation(root: string): Promise<void> {
  const staged = await stageSuccessfully(root);
  const nonce = requireLaunch(
    staged.harness.controller.prepareStartup(DRILL_OLD_APP, null),
    staged.appPath,
  );
  const afterLaunch = reopenDrillState(root);
  const controller = staged.harness.controllerFor(afterLaunch);
  const startup = controller.prepareStartup(staged.appPath, nonce);
  requireDrill(
    startup.action === "continue" &&
      startup.pendingConfirmation?.slot === "B" &&
      startup.pendingConfirmation.nonce === nonce,
    "healthy launched update did not request exact activation confirmation",
  );
  controller.confirmStartup({ slot: "B", nonce });
  const persisted = reopenDrillState(root).snapshot();
  requireDrill(
    persisted.active_slot === "B" && persisted.pending_activation === null,
    "activation confirmation was not durable",
  );
}

async function runSecurityFloorRecovery(root: string): Promise<void> {
  const staged = await stageSuccessfully(root);
  staged.harness.state.raiseSecurityFloor("2.0.0", "2026-07-31T03:05:00.000Z");
  requireLaunch(staged.harness.controller.prepareStartup(DRILL_OLD_APP, null), staged.appPath);
  const beforeCrash = reopenDrillState(root).snapshot().pending_activation;
  requireDrill(beforeCrash !== null, "security-floor scenario lost pending state before crash");
  const afterCrash = reopenDrillState(root);
  const action = staged.harness.controllerFor(afterCrash).prepareStartup(DRILL_OLD_APP, null);
  requireDrill(action.action === "recovery", "security floor did not enter recovery");
  requireArrayEqual(
    action.capabilities,
    ["read_only", "print_only"],
    "unsafe recovery capabilities",
  );
  requireDrill(Object.isFrozen(action.capabilities), "recovery capabilities were mutable");
  const persisted = reopenDrillState(root).snapshot();
  requireDrill(
    persisted.active_slot === "B" &&
      persisted.minimum_secure_version === "2.0.0" &&
      JSON.stringify(persisted.pending_activation) === JSON.stringify(beforeCrash),
    "security-floor recovery altered authoritative pending state",
  );
}

type ScenarioRunner = (root: string) => Promise<void>;

function scenarioRunners(): readonly Readonly<{
  name: RuntimeRecoveryDrillScenario;
  run: ScenarioRunner;
}>[] {
  return Object.freeze([
    Object.freeze({ name: "tampered_signature", run: runTamperedSignature }),
    Object.freeze({
      name: "pending_queue_before_network",
      run: (root: string) => runQueueBlock(root, "pending"),
    }),
    Object.freeze({
      name: "inflight_queue_before_network",
      run: (root: string) => runQueueBlock(root, "inflight"),
    }),
    Object.freeze({
      name: "download_interrupted_cleanup",
      run: (root: string) =>
        runFailedStage(
          root,
          withOptions({ download: "interrupted" }),
          "simulated artifact transport interruption",
        ),
    }),
    Object.freeze({
      name: "digest_mismatch_cleanup",
      run: (root: string) =>
        runFailedStage(
          root,
          withOptions({ download: "digest_mismatch" }),
          "Update artifact did not match its signed size and digest",
        ),
    }),
    Object.freeze({
      name: "extract_interrupted_cleanup",
      run: (root: string) =>
        runFailedStage(
          root,
          withOptions({ extract: "interrupted" }),
          "simulated macOS extraction interruption",
        ),
    }),
    Object.freeze({
      name: "team_mismatch_cleanup",
      run: (root: string) =>
        runFailedStage(
          root,
          withOptions({ extract: "team_mismatch" }),
          "Update app signing team does not match",
        ),
    }),
    Object.freeze({
      name: "health_rejected_cleanup",
      run: (root: string) =>
        runFailedStage(root, withOptions({ health: false }), "UPDATE_STAGED_HEALTH_FAILED"),
    }),
    Object.freeze({ name: "normal_stage_retains_release", run: runNormalStage }),
    Object.freeze({ name: "activate_crash_persists_pending", run: runActivateCrash }),
    Object.freeze({ name: "launch_crash_rolls_back", run: runLaunchCrash }),
    Object.freeze({ name: "activation_confirmed", run: runActivationConfirmation }),
    Object.freeze({ name: "security_floor_recovery", run: runSecurityFloorRecovery }),
  ]);
}

export async function runRuntimeRecoveryDrill(): Promise<RuntimeRecoveryDrillReport> {
  const root = await mkdtemp(join(tmpdir(), "laundry-runtime-recovery-drill-"));
  let completed: readonly RuntimeRecoveryDrillScenario[] = Object.freeze([]);
  try {
    for (const scenario of scenarioRunners()) {
      const scenarioRoot = join(root, scenario.name);
      await mkdir(scenarioRoot, { mode: 0o700 });
      await scenario.run(scenarioRoot);
      completed = Object.freeze([...completed, scenario.name]);
    }
    requireArrayEqual(completed, RUNTIME_RECOVERY_DRILL_SCENARIOS, "scenario matrix incomplete");
    return Object.freeze({ ok: true, scenarios: completed });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
