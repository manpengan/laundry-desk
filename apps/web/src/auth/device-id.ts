/** Device id is generated once per page lifetime and kept in memory only. */

let deviceIdMemory: string | null = null;

function createUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Deterministic fallback for very old hosts (should not hit Node 22+).
  return "00000000-0000-4000-8000-0000000000de";
}

export function getDeviceId(): string {
  if (deviceIdMemory === null) {
    deviceIdMemory = createUuid();
  }
  return deviceIdMemory;
}

/** Test helper only — resets the in-memory device id. */
export function resetDeviceIdForTests(): void {
  deviceIdMemory = null;
}

export function setDeviceIdForTests(id: string): void {
  deviceIdMemory = id;
}
