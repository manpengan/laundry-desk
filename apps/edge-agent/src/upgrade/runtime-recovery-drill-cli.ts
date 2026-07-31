import { runRuntimeRecoveryDrill } from "./runtime-recovery-drill.js";

void runRuntimeRecoveryDrill()
  .then(() => {
    process.stdout.write("UPDATE_RECOVERY_DRILL_OK\n");
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "runtime recovery drill failed";
    process.stderr.write(`[update-recovery-drill] ${message}\n`);
    process.exitCode = 1;
  });
