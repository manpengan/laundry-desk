import { describe, expect, it } from "vitest";

import {
  FactoryHandoffStateError,
  advanceFactoryHandoff,
  computeHandoffDifference,
  expectedFactoryHandoffCheckpoint,
} from "../lifecycle.js";

describe("factory handoff lifecycle", () => {
  it("advances the four custody checkpoints without changing garment lifecycle status", () => {
    expect(advanceFactoryHandoff("packing", "store_dispatch")).toEqual({
      status: "store_dispatched",
      custodyState: "to_factory",
    });
    expect(advanceFactoryHandoff("store_dispatched", "factory_receive")).toEqual({
      status: "factory_received",
      custodyState: "factory",
    });
    expect(advanceFactoryHandoff("factory_received", "factory_dispatch")).toEqual({
      status: "factory_dispatched",
      custodyState: "to_store",
    });
    expect(advanceFactoryHandoff("factory_dispatched", "store_receive")).toEqual({
      status: "store_received",
      custodyState: "store",
    });
  });

  it("fails closed on skipped, repeated and terminal checkpoints", () => {
    expect(expectedFactoryHandoffCheckpoint("factory_received")).toBe("factory_dispatch");
    expect(() => advanceFactoryHandoff("packing", "factory_receive")).toThrow(
      FactoryHandoffStateError,
    );
    expect(() => advanceFactoryHandoff("store_received", "store_receive")).toThrow(
      FactoryHandoffStateError,
    );
  });

  it("computes a deterministic set difference without mutating caller arrays", () => {
    const expected = Object.freeze(["G-002", "G-001"]);
    const scanned = Object.freeze(["G-003", "G-002"]);

    expect(computeHandoffDifference(expected, scanned)).toEqual({
      matched: ["G-002"],
      missing: ["G-001"],
      unexpected: ["G-003"],
    });
    expect(expected).toEqual(["G-002", "G-001"]);
    expect(scanned).toEqual(["G-003", "G-002"]);
  });

  it("rejects duplicate values before computing a custody result", () => {
    expect(() => computeHandoffDifference(["G-001", "G-001"], ["G-001"])).toThrow(/unique/iu);
  });
});
