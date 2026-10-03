import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  extractV1Snapshot,
  reconcileMigration,
  transformV1Snapshot,
  validateMigrationPlan,
} from "../src/index.js";
import { createFixtureDatabase } from "./helpers.js";

describe("schema-owned migration boundary", () => {
  it("preserves null/legacy fields and binds the exact reviewed deterministic mapping", async () => {
    const fixture = await createFixtureDatabase();
    try {
      const source = await extractV1Snapshot(fixture.path);
      const plan = transformV1Snapshot(source);
      const report = reconcileMigration(source, plan);
      const valid = validateMigrationPlan(plan, report);
      expect(valid.plan.sourceSnapshot).toEqual(source);
      expect(valid.planSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(
        validateMigrationPlan(JSON.parse(JSON.stringify(plan)), JSON.parse(JSON.stringify(report)))
          .planSha256,
      ).toBe(valid.planSha256);
      expect(() => validateMigrationPlan({ ...plan, customers: [] }, report)).toThrow("MISMATCH");
      expect(() => validateMigrationPlan(plan, { ...report, isZeroDifference: false })).toThrow(
        "MISMATCH",
      );
      expect(() => validateMigrationPlan({ ...plan, sourceSnapshot: undefined }, report)).toThrow();
      const repeated = { ...source, customers: [...source.customers, source.customers[0]!] };
      expect(() => validateMigrationPlan({ ...plan, sourceSnapshot: repeated }, report)).toThrow(
        "DUPLICATE",
      );
      const extraField = { ...source, injected: "not mapped" };
      expect(() =>
        validateMigrationPlan({ ...plan, sourceSnapshot: extraField }, report),
      ).toThrow();
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
