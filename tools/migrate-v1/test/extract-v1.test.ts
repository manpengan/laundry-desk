import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { extractV1Snapshot } from "../src/extract-v1.js";
import { createFixtureDatabase } from "./helpers.js";

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

describe("extractV1Snapshot", () => {
  it("copies then reads the v1 SQLite source without changing it", async () => {
    const fixture = await createFixtureDatabase();
    try {
      const before = await sha256(fixture.path);
      const snapshot = await extractV1Snapshot(fixture.path);
      expect(await sha256(fixture.path)).toBe(before);
      expect(snapshot.sourceBackupSha256).toBe(before);
      expect(snapshot.customers).toHaveLength(2);
      expect(snapshot.orders).toHaveLength(2);
      expect(snapshot.orderItems).toHaveLength(2);
      expect(snapshot.orderPhotos).toHaveLength(1);
    } finally {
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });
});
