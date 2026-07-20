/** Placeholder connection snapshot until A4/E1 wire real channels. */

export type EdgeConnectionSnapshot = {
  mode: "online" | "offline" | "degraded";
  pendingSyncCount: number;
  source: "mock";
};

export function mockConnection(
  overrides: Partial<EdgeConnectionSnapshot> = {},
): EdgeConnectionSnapshot {
  return {
    mode: "online",
    pendingSyncCount: 0,
    source: "mock",
    ...overrides,
  };
}
