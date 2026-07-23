import { rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { extractV1Snapshot } from "../src/extract-v1.js";
import { reconcileMigration } from "../src/reconcile.js";
import { transformV1Snapshot } from "../src/transform.js";
import { createFixtureDatabase } from "./helpers.js";

describe("transformV1Snapshot", () => {
  it("splits every v1 qty into one line and one uniquely barcoded garment per piece", async () => {
    const fixture = await createFixtureDatabase();
    try {
      const snapshot = await extractV1Snapshot(fixture.path);
      const plan = transformV1Snapshot(snapshot);
      const first = plan.orders[0];
      const second = plan.orders[1];
      expect(first?.lines).toHaveLength(1);
      expect(first?.garments).toHaveLength(3);
      expect(second?.garments).toHaveLength(2);
      expect(
        new Set(plan.orders.flatMap((order) => order.garments.map((garment) => garment.barcode)))
          .size,
      ).toBe(5);
      expect(first?.status).toBe("closed");
      expect(second?.garments.every((garment) => garment.status === "ready")).toBe(true);
      expect(plan.photos[0]?.garmentId).toBe(first?.garments[0]?.id);
      expect(plan.orders[1]?.createdAt).toBe(1720000200);
      expect(reconcileMigration(snapshot, plan).isZeroDifference).toBe(true);
    } finally {
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });

  it("is deterministic for a source backup so a loader can be idempotent", async () => {
    const fixture = await createFixtureDatabase();
    try {
      const snapshot = await extractV1Snapshot(fixture.path);
      expect(transformV1Snapshot(snapshot)).toEqual(transformV1Snapshot(snapshot));
    } finally {
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });
});
