import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseCliOptions, runCli } from "../src/cli.js";
import { createFixtureDatabase } from "./helpers.js";

describe("migration CLI", () => {
  it("repeats the sanitized dry-run with identical evidence and no customer PII", async () => {
    const fixture = await createFixtureDatabase();
    try {
      const sourceBefore = createHash("sha256")
        .update(await readFile(fixture.path))
        .digest("hex");
      const run = async () => {
        const output: string[] = [];
        const result = await runCli(["--source", fixture.path], {
          write: (line) => output.push(line),
          extract: (await import("../src/extract-v1.js")).extractV1Snapshot,
          transform: (await import("../src/transform.js")).transformV1Snapshot,
          reconcile: (await import("../src/reconcile.js")).reconcileMigration,
          load: (await import("../src/load-v2.js")).loadV2Migration,
          importLoader: async () => {
            throw new Error("dry run must not import a loader");
          },
        });
        expect(result).toBe(0);
        return output.join("\n");
      };
      const first = await run();
      const second = await run();
      expect(second).toBe(first);
      expect(first).toContain('"mode":"dry-run"');
      expect(first).toContain('"isZeroDifference":true');
      expect(first).not.toContain("13800000101");
      expect(first).not.toContain("测试顾客甲");
      expect(
        createHash("sha256")
          .update(await readFile(fixture.path))
          .digest("hex"),
      ).toBe(sourceBefore);
    } finally {
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });

  it("requires an explicit target, loader and reviewed source hash before apply", async () => {
    const output: string[] = [];
    const result = await runCli(["--source", "fixture.db", "--apply"], {
      write: (line) => output.push(line),
      extract: async () => {
        throw new Error("must not extract before apply safeguards");
      },
      transform: () => {
        throw new Error("not reached");
      },
      reconcile: () => {
        throw new Error("not reached");
      },
      load: async () => {
        throw new Error("not reached");
      },
      importLoader: async () => {
        throw new Error("not reached");
      },
    });
    expect(result).toBe(2);
    expect(output[0]).toContain("V1_MIGRATION_OPTIONS_INVALID");
  });

  it("rejects ambiguous grammar and apply-only dry-run inputs", () => {
    expect(() => parseCliOptions(["--source", "one.db", "--source", "two.db"])).toThrow();
    expect(() => parseCliOptions(["--source", "one.db", "positional"])).toThrow();
    expect(() =>
      parseCliOptions(["--source", "one.db", "--target", "postgresql://example.test/db"]),
    ).toThrow();
  });

  it("redacts target credentials and loader exceptions behind a stable failure code", async () => {
    const fixture = await createFixtureDatabase();
    const output: string[] = [];
    const target = "postgresql://migration:loader-secret@example.test/laundry";
    try {
      const extract = (await import("../src/extract-v1.js")).extractV1Snapshot;
      const sourceHash = (await extract(fixture.path)).sourceBackupSha256;
      const result = await runCli(
        [
          "--source",
          fixture.path,
          "--apply",
          "--target",
          target,
          "--loader",
          "loader.mjs",
          "--confirm-source-sha256",
          sourceHash,
        ],
        {
          write: (line) => output.push(line),
          extract,
          transform: (await import("../src/transform.js")).transformV1Snapshot,
          reconcile: (await import("../src/reconcile.js")).reconcileMigration,
          load: (await import("../src/load-v2.js")).loadV2Migration,
          importLoader: async () => {
            throw new Error(`cannot connect to ${target}`);
          },
        },
      );
      expect(result).toBe(2);
      expect(output.at(-1)).toContain("V1_MIGRATION_LOADER_INVALID");
      expect(output.join("\n")).not.toContain(target);
      expect(output.join("\n")).not.toContain("loader-secret");
    } finally {
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });
});
