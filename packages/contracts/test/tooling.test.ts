import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import vitestConfig from "../vitest.config.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(packageRoot, path), "utf8"));
}

it("loads the package-local Vitest and Zod toolchain", () => {
  expect(z.string().parse("contracts-ready")).toBe("contracts-ready");
});

it("keeps test typechecking strict instead of skipping dependency declarations", () => {
  const tsconfig = z
    .object({
      compilerOptions: z.object({ skipLibCheck: z.boolean().optional() }),
    })
    .parse(readJson("tsconfig.test.json"));

  expect(tsconfig.compilerOptions.skipLibCheck).not.toBe(true);
});

it("enforces at least 70 percent V8 coverage on all four dimensions", () => {
  const coverage = z
    .object({
      provider: z.literal("v8"),
      thresholds: z.object({
        branches: z.number(),
        functions: z.number(),
        lines: z.number(),
        statements: z.number(),
      }),
    })
    .parse(vitestConfig.test?.coverage);

  expect(coverage.provider).toBe("v8");
  expect(coverage.thresholds.lines).toBeGreaterThanOrEqual(70);
  expect(coverage.thresholds.statements).toBeGreaterThanOrEqual(70);
  expect(coverage.thresholds.functions).toBeGreaterThanOrEqual(70);
  expect(coverage.thresholds.branches).toBeGreaterThanOrEqual(70);
});

it("declares the package-local V8 coverage provider", () => {
  const packageJson = z
    .object({
      devDependencies: z.record(z.string(), z.string()),
    })
    .parse(readJson("package.json"));

  expect(packageJson.devDependencies["@vitest/coverage-v8"]).toBeDefined();
});

it("runs coverage thresholds in the canonical package test gate", () => {
  const packageJson = z
    .object({ scripts: z.object({ test: z.string() }) })
    .parse(readJson("package.json"));

  expect(packageJson.scripts.test).toBe("vitest run --coverage");
});
