import { rmSync } from "node:fs";
import { stat } from "node:fs/promises";

export function registerKeyCleanup(arguments_, path) {
  const orchestrated = arguments_.length === 1 && arguments_[0] === "--orchestrated";
  if (arguments_.length !== 0 && !orchestrated) throw new Error("RUNTIME_ACCEPTANCE_ARGS_INVALID");
  process.once("exit", () => {
    if (!orchestrated) rmSync(path, { force: true });
  });
}

export const setup = JSON.stringify({
  adminUsername: "owner",
  adminDisplayName: "店长",
  adminPassword: "native-acceptance-password",
  adminPin: "86420987",
  approverUsername: "approver",
  approverDisplayName: "复核管理员",
  approverPassword: "independent-approver-password",
  approverPin: "97531864",
});

export const commissionSetup = JSON.stringify({
  approverUsername: "legacy-approver",
  approverDisplayName: "既有门店复核管理员",
  approverPassword: "legacy-approver-password",
  approverPin: "753186",
});

export async function waitForFile(path) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}
