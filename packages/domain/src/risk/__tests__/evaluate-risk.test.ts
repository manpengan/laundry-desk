import { describe, expect, it } from "vitest";

import {
  evaluateRisk,
  mergeStricterLimitOverride,
  type LimitGroups,
  type RiskLevel,
} from "../evaluate-risk.js";

const factoryTwoDim: LimitGroups = {
  hard_limits: { max_batch: 100, max_amount_cents: 50_000 },
  risk_escalation: { max_batch: 20, max_amount_cents: 10_000 },
};

/** Two-dim factory requires both measures (contracts: threshold ⇒ size_measures). */
const underBoth = { batch: 1, amount_cents: 100 } as const;

describe("evaluateRisk base risk passthrough", () => {
  it.each(["R0", "R1", "R2", "R3", "R4", "R5"] as const)(
    "returns base risk %s when no limits apply",
    (baseRisk: RiskLevel) => {
      const result = evaluateRisk({
        baseRisk,
        measures: {},
      });
      expect(result).toMatchObject({ ok: true, risk: baseRisk, escalated: false });
    },
  );
});

describe("evaluateRisk hard_limits reject before escalation", () => {
  it("rejects when batch exceeds hard limit", () => {
    const result = evaluateRisk({
      baseRisk: "R3",
      measures: { batch: 101, amount_cents: 100 },
      factoryLimits: factoryTwoDim,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("hard_limit_exceeded");
      expect(result.dimension).toBe("max_batch");
      expect(result.measured).toBe(101);
      expect(result.limit).toBe(100);
    }
  });

  it("rejects when amount exceeds hard limit even if escalation would also fire", () => {
    const result = evaluateRisk({
      baseRisk: "R3",
      measures: { batch: 1, amount_cents: 60_000 },
      factoryLimits: factoryTwoDim,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("hard_limit_exceeded");
      expect(result.dimension).toBe("max_amount_cents");
    }
  });

  it("does not reject when measured equals the hard limit (strictly greater)", () => {
    const result = evaluateRisk({
      baseRisk: "R4",
      measures: { batch: 100 },
      factoryLimits: { hard_limits: { max_batch: 100 } },
    });
    expect(result).toMatchObject({ ok: true, risk: "R4", escalated: false });
  });

  it("fails closed when a hard limit dimension has no measured value", () => {
    const result = evaluateRisk({
      baseRisk: "R2",
      measures: {},
      factoryLimits: { hard_limits: { max_batch: 10 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_measure");
  });

  it("never escalates a hard-limit rejection into R4", () => {
    const result = evaluateRisk({
      baseRisk: "R3",
      measures: { batch: 150 },
      factoryLimits: {
        hard_limits: { max_batch: 100 },
        risk_escalation: { max_batch: 20 },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("hard_limit_exceeded");
  });
});

describe("evaluateRisk R3→R4 escalation", () => {
  it("escalates R3 to R4 when batch crosses escalation threshold", () => {
    const result = evaluateRisk({
      baseRisk: "R3",
      measures: { batch: 21, amount_cents: 100 },
      factoryLimits: factoryTwoDim,
    });
    expect(result).toMatchObject({ ok: true, risk: "R4", escalated: true });
  });

  it("escalates R3 to R4 when amount crosses escalation threshold", () => {
    const result = evaluateRisk({
      baseRisk: "R3",
      measures: { batch: 1, amount_cents: 10_001 },
      factoryLimits: factoryTwoDim,
    });
    expect(result).toMatchObject({ ok: true, risk: "R4", escalated: true });
  });

  it("does not escalate when measured equals the escalation threshold", () => {
    const result = evaluateRisk({
      baseRisk: "R3",
      measures: { batch: 20, amount_cents: 10_000 },
      factoryLimits: factoryTwoDim,
    });
    expect(result).toMatchObject({ ok: true, risk: "R3", escalated: false });
  });

  it("does not escalate non-R3 base risks even when measures cross thresholds", () => {
    for (const baseRisk of ["R0", "R1", "R2", "R4", "R5"] as const) {
      const result = evaluateRisk({
        baseRisk,
        measures: { batch: 50, amount_cents: 100 },
        factoryLimits: factoryTwoDim,
      });
      expect(result).toMatchObject({ ok: true, risk: baseRisk, escalated: false });
    }
  });

  it("escalates when only one of two dimensions crosses its line", () => {
    const result = evaluateRisk({
      baseRisk: "R3",
      measures: { batch: 5, amount_cents: 10_001 },
      factoryLimits: factoryTwoDim,
    });
    expect(result).toMatchObject({ ok: true, risk: "R4", escalated: true });
  });

  it("keeps R3 when below both escalation lines", () => {
    const result = evaluateRisk({
      baseRisk: "R3",
      measures: underBoth,
      factoryLimits: factoryTwoDim,
    });
    expect(result).toMatchObject({ ok: true, risk: "R3", escalated: false });
  });
});

describe("evaluateRisk per-org override only stricter", () => {
  it("applies a tighter escalation line", () => {
    const result = evaluateRisk({
      baseRisk: "R3",
      measures: { batch: 15, amount_cents: 100 },
      factoryLimits: factoryTwoDim,
      orgOverride: { risk_escalation: { max_batch: 10 } },
    });
    expect(result).toMatchObject({
      ok: true,
      risk: "R4",
      escalated: true,
      effectiveLimits: {
        hard_limits: { max_batch: 100, max_amount_cents: 50_000 },
        risk_escalation: { max_batch: 10, max_amount_cents: 10_000 },
      },
    });
  });

  it("applies a tighter hard limit and rejects", () => {
    const result = evaluateRisk({
      baseRisk: "R3",
      measures: { batch: 30, amount_cents: 100 },
      factoryLimits: factoryTwoDim,
      orgOverride: { hard_limits: { max_batch: 25 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("hard_limit_exceeded");
      expect(result.limit).toBe(25);
    }
  });

  it("rejects a wider override (fail-closed, never softens)", () => {
    const result = evaluateRisk({
      baseRisk: "R3",
      measures: underBoth,
      factoryLimits: factoryTwoDim,
      orgOverride: { hard_limits: { max_batch: 101 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_override");
  });

  it("rejects an override dimension absent from factory", () => {
    const result = evaluateRisk({
      baseRisk: "R3",
      measures: { batch: 1 },
      factoryLimits: { hard_limits: { max_batch: 100 } },
      orgOverride: { hard_limits: { max_amount_cents: 1_000 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_override");
  });

  it("rejects override that would make escalation exceed tightened hard limit", () => {
    const result = evaluateRisk({
      baseRisk: "R3",
      measures: underBoth,
      factoryLimits: factoryTwoDim,
      orgOverride: { hard_limits: { max_batch: 10 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_override");
  });

  it("accepts an override equal to the factory line", () => {
    const result = evaluateRisk({
      baseRisk: "R3",
      measures: { batch: 20, amount_cents: 10_000 },
      factoryLimits: factoryTwoDim,
      orgOverride: { risk_escalation: { max_batch: 20 } },
    });
    expect(result).toMatchObject({ ok: true, risk: "R3", escalated: false });
  });
});

describe("mergeStricterLimitOverride", () => {
  it("merges without mutating factory", () => {
    const factory = {
      hard_limits: { max_batch: 100, max_amount_cents: 50_000 },
      risk_escalation: { max_batch: 20, max_amount_cents: 10_000 },
    };
    const merged = mergeStricterLimitOverride(factory, {
      hard_limits: { max_batch: 80 },
      risk_escalation: { max_amount_cents: 8_000 },
    });
    expect(merged).toEqual({
      ok: true,
      limits: {
        hard_limits: { max_batch: 80, max_amount_cents: 50_000 },
        risk_escalation: { max_batch: 20, max_amount_cents: 8_000 },
      },
    });
    expect(factory.hard_limits.max_batch).toBe(100);
  });

  it("rejects non-positive thresholds", () => {
    const result = mergeStricterLimitOverride(
      { hard_limits: { max_batch: 10 } },
      { hard_limits: { max_batch: 0 } },
    );
    expect(result.ok).toBe(false);
  });
});

describe("evaluateRisk order invariant", () => {
  it("hard reject wins when value is above both hard and escalation", () => {
    const result = evaluateRisk({
      baseRisk: "R3",
      measures: { batch: 1, amount_cents: 50_001 },
      factoryLimits: factoryTwoDim,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("hard_limit_exceeded");
  });

  it("escalation runs only after hard limits pass", () => {
    const underHard = evaluateRisk({
      baseRisk: "R3",
      measures: { batch: 1, amount_cents: 49_999 },
      factoryLimits: factoryTwoDim,
    });
    expect(underHard).toMatchObject({ ok: true, risk: "R4", escalated: true });
  });
});
