import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";

const MAX_LOG_CHUNKS = 4_000;

/**
 * ADR-91 P1-8: keep the installed app's main-process output so a failed acceptance run
 * says why the process went away. The desktop app never prints credentials or bodies.
 */
export function captureMainProcessOutput(application: ElectronApplication) {
  const chunks: string[] = [];
  const record = (chunk: Buffer | string) => {
    if (chunks.length < MAX_LOG_CHUNKS) chunks.push(String(chunk));
  };
  const child = application.process();
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  return Object.freeze({
    async save(evidenceRoot: string, name = "main-process.log"): Promise<void> {
      const exit = `exit_code=${String(child.exitCode)} signal=${String(child.signalCode)}\n`;
      await writeFile(join(evidenceRoot, name), exit + chunks.join(""), {
        encoding: "utf8",
        flag: "w",
      });
    },
  });
}

const retriedEvaluations: string[] = [];

/** Main-process evaluations this run retried after a destroyed context, for the evidence. */
export function retriedMainEvaluations(): readonly string[] {
  return Object.freeze([...retriedEvaluations]);
}

/**
 * "Execution context was destroyed" also happens when the main window reloads. Only a
 * main process that has exited is a failure; a live one is asked once more after its
 * first window is available again, and the retry is recorded so a pass cannot hide it.
 */
export async function evaluateInMain<R>(
  application: ElectronApplication,
  run: () => Promise<R>,
): Promise<R> {
  try {
    return await run();
  } catch (error) {
    if (!/Execution context was destroyed/u.test(String(error))) throw error;
    const child = application.process();
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Electron main process exited (code ${String(child.exitCode)}, signal ${String(child.signalCode)})`,
        { cause: error },
      );
    retriedEvaluations.push(String(error).split("\n")[0] ?? "");
    await application.firstWindow();
    return await run();
  }
}
