import { rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { createFixtureDatabase } from "./helpers.js";

describe("migration CLI", () => {
  it("defaults to dry-run and emits reconciliation counts without customer PII", async () => {
    const fixture = await createFixtureDatabase();
    const output: string[] = [];
    try {
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
      expect(output.join("\n")).toContain('"mode":"dry-run"');
      expect(output.join("\n")).not.toContain("13800000101");
      expect(output.join("\n")).not.toContain("测试顾客甲");
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
    expect(output[0]).toContain("explicit --target");
  });
});
