import { prepareRuntimeStartup, type StartupAction } from "./runtime-controller.js";
import { RUNTIME_RECOVERY_CAPABILITIES, type RuntimeUpdateStateStore } from "./runtime-state.js";

/** At most two candidates; corruption never retries the same slot on every launch. */
export async function prepareVerifiedStartup(
  state: RuntimeUpdateStateStore,
  currentPath: string,
  activationNonce: string | null,
  validate: (path: string) => Promise<void>,
): Promise<StartupAction> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const startup = prepareRuntimeStartup(
      state,
      currentPath,
      attempt === 0 ? activationNonce : null,
    );
    if (startup.action === "recovery") return startup;
    try {
      await validate(startup.action === "launch" ? startup.appPath : currentPath);
      return startup;
    } catch {
      state.rejectActiveSlot(new Date().toISOString());
    }
  }
  return Object.freeze({ action: "recovery", capabilities: RUNTIME_RECOVERY_CAPABILITIES });
}
