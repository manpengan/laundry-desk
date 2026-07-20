import type { HistoryEntry, SlotName, UpgradeState } from "./types.js";

export const DEFAULT_MIN_SECURE_VERSION = "1.8.0";

export function createInitialState(overrides: Partial<UpgradeState> = {}): UpgradeState {
  return {
    activeSlot: "A",
    slots: {
      A: { version: "1.9.0", healthy: true },
      B: { version: null, healthy: false },
    },
    queueEmpty: true,
    primaryLeaseIssuanceBlocked: false,
    localSchema: 3,
    contractPhaseDone: false,
    minSecureVersion: DEFAULT_MIN_SECURE_VERSION,
    mode: "ACTIVE",
    history: [],
    ...overrides,
  };
}

export function standbySlot(active: SlotName): SlotName {
  return active === "A" ? "B" : "A";
}

export function appendHistory(
  state: UpgradeState,
  event: string,
  detail?: Record<string, unknown>,
  now: () => string = () => new Date().toISOString(),
): UpgradeState {
  const entry: HistoryEntry = detail ? { at: now(), event, detail } : { at: now(), event };
  return {
    ...state,
    history: [...state.history, entry],
  };
}
