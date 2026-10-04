import type { RuntimeUpdateState } from "./runtime-state.js";
import { compareVersion } from "./version.js";

export function rejectActiveSlot(state: RuntimeUpdateState, now: string): RuntimeUpdateState {
  const failed = state.active_slot;
  const fallback = failed === "A" ? "B" : "A";
  const previous = state.slots[fallback];
  const usable =
    previous.healthy &&
    previous.app_path !== null &&
    previous.version !== null &&
    compareVersion(previous.version, state.minimum_secure_version) >= 0;
  return {
    ...state,
    active_slot: usable ? fallback : failed,
    pending_activation: null,
    slots: { ...state.slots, [failed]: { ...state.slots[failed], healthy: false } },
    history: [
      ...state.history.slice(-198),
      {
        at: now,
        event: usable ? "corrupt_slot_fallback" : "corrupt_slot_recovery_required",
        slot: failed,
      },
    ],
  };
}
