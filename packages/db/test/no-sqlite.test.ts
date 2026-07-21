import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");

const collectFiles = (directory: string, predicate: (name: string) => boolean): string[] => {
  const entries = readdirSync(directory);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "coverage") continue;
    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...collectFiles(fullPath, predicate));
      continue;
    }
    if (predicate(entry)) files.push(fullPath);
  }
  return files;
};

describe("@laundry/db isolation from v1 SQLite", () => {
  it("does not depend on better-sqlite3", () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };
    expect(deps["better-sqlite3"]).toBeUndefined();
    expect(deps["@types/better-sqlite3"]).toBeUndefined();
  });

  it("drizzle.config uses postgresql dialect only", () => {
    const config = readFileSync(join(packageRoot, "drizzle.config.ts"), "utf8");
    expect(config).toMatch(/dialect:\s*["']postgresql["']/u);
    expect(config).not.toMatch(/dialect:\s*["']sqlite["']/u);
    expect(config).not.toMatch(/\bbetter-sqlite3\b/u);
    expect(config).not.toMatch(/src\/main\/db/u);
    expect(config).not.toMatch(/\.\.\/\.\.\/drizzle\.config/u);
  });

  it("package sources never import v1 desktop DB modules", () => {
    const bannedToken = ["better", "sqlite3"].join("-");
    const sources = [
      ...collectFiles(join(packageRoot, "src"), (name) => /\.(?:[cm]?[jt]s|tsx|sql)$/u.test(name)),
      join(packageRoot, "package.json"),
      join(packageRoot, "drizzle.config.ts"),
    ];
    const forbidden = [
      new RegExp(`\\b${bannedToken}\\b`, "u"),
      /from\s+["']drizzle-orm\/better-sqlite3["']/u,
      /src\/main\/db/u,
      /laundry\.db/u,
      /dialect:\s*["']sqlite["']/u,
    ];

    for (const filePath of sources) {
      const rel = relative(repoRoot, filePath);
      if (rel.includes("node_modules") || rel.includes("dist")) continue;
      const body = readFileSync(filePath, "utf8");
      for (const pattern of forbidden) {
        expect(body, `${rel} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
