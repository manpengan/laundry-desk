import { rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { extractV1Snapshot } from "../src/extract-v1.js";
import { reconcileMigration } from "../src/reconcile.js";
import { transformV1Snapshot } from "../src/transform.js";
import { createFixtureDatabase } from "./helpers.js";

describe("reconcileMigration", () => {
  it("reports zero differences for orders, garments, customers, money, debt and photos", async () => {
    const fixture = await createFixtureDatabase();
    try {
      const snapshot = await extractV1Snapshot(fixture.path);
      const report = reconcileMigration(snapshot, transformV1Snapshot(snapshot));
      expect(report).toMatchObject({
        isZeroDifference: true,
        source: {
          orders: 2,
          garments: 5,
          customers: 2,
          receivableCents: 7500,
          paidCents: 5500,
          debtCents: 2000,
          photos: 1,
        },
        differences: {
          orders: 0,
          garments: 0,
          customers: 0,
          receivableCents: 0,
          paidCents: 0,
          debtCents: 0,
          photos: 0,
        },
      });
    } finally {
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });
});
