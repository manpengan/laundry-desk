import { rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { extractV1Snapshot } from "../src/extract-v1.js";
import { loadV2Migration, type V2PostgresMigrationLoader } from "../src/load-v2.js";
import { reconcileMigration } from "../src/reconcile.js";
import { transformV1Snapshot } from "../src/transform.js";
import { createFixtureDatabase } from "./helpers.js";

describe("loadV2Migration", () => {
  it("requires a v2 backup point before delegating idempotent PG apply", async () => {
    const fixture = await createFixtureDatabase();
    const calls: string[] = [];
    try {
      const snapshot = await extractV1Snapshot(fixture.path);
      const plan = transformV1Snapshot(snapshot);
      const report = reconcileMigration(snapshot, plan);
      const loader: V2PostgresMigrationLoader = Object.freeze({
        kind: "v2-postgresql" as const,
        createBackupPoint: async () => {
          calls.push("backup");
          return Object.freeze({ id: "backup-point-1" });
        },
        applyIdempotently: async (request) => {
          calls.push(`apply:${request.backupPointId}`);
        },
      });
      await loadV2Migration(loader, "postgresql://migration@example.test/laundry", plan, report);
      expect(calls).toEqual(["backup", "apply:backup-point-1"]);
    } finally {
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });
});
