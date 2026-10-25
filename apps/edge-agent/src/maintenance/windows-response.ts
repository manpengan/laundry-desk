import type { Readable, Writable } from "node:stream";
import type { DesktopMaintenanceInput } from "@laundry/contracts";

export const MAINTENANCE_HEALTH_TIMEOUT_MS = 90_000;
export const MAINTENANCE_OPEN_TIMEOUT_MS = 30_000;

type MaintenanceChild = Readonly<{
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on: (event: "error", listener: (error: Error) => void) => unknown;
  once: (event: "close", listener: (code: number | null) => void) => unknown;
  kill: () => unknown;
  unref: () => unknown;
}>;

// Health verifies the complete bound Runtime before reading its backup state. The same-source
// Windows CI measured a successful health command at 36,391 ms, beyond the GUI startup budget.
export function maintenanceResponse(
  child: MaintenanceChild,
  operation: DesktopMaintenanceInput["operation"],
  authorize: () => boolean,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const fail = (code = "MAINTENANCE_START_FAILED") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error(code));
    };
    const timer = setTimeout(
      () => fail("MAINTENANCE_TIMEOUT"),
      operation === "health" ? MAINTENANCE_HEALTH_TIMEOUT_MS : MAINTENANCE_OPEN_TIMEOUT_MS,
    );
    const failed = () => fail();
    child.on("error", failed);
    child.stdin.on("error", failed);
    child.stdout.on("error", failed);
    child.stderr.on("error", failed);
    child.stderr.on("data", failed);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      output += chunk.toString("utf8");
      if (output.length > 32768) {
        fail();
        return;
      }
      if (operation !== "health" && output.includes("\n")) {
        try {
          const value: unknown = JSON.parse(output.trim());
          if (!authorize()) {
            fail();
            return;
          }
          settled = true;
          clearTimeout(timer);
          child.unref();
          resolve(value);
        } catch {
          fail();
        }
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0 || !authorize()) {
        fail();
        return;
      }
      try {
        const value: unknown = JSON.parse(output.trim());
        settled = true;
        clearTimeout(timer);
        resolve(value);
      } catch {
        fail();
      }
    });
  });
}
