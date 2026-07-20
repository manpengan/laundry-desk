import type { HealthReport } from "./types.js";

/** All three checks must pass before promoting standby (ADR-08 §5). */
export function isHealthPassing(report: HealthReport): boolean {
  return report.hardwareOk && report.localDbOpen && report.serverHandshakeOk;
}

export function healthFromPassFail(pass: boolean): HealthReport {
  return {
    hardwareOk: pass,
    localDbOpen: pass,
    serverHandshakeOk: pass,
  };
}
