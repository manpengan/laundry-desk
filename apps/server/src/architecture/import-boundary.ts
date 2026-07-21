/**
 * Architecture lint: routes / AI / worker paths may only call the command bus.
 * They must not import write services or repositories directly (ADR-05 #1).
 *
 * M1 skeleton uses static source-string scan — no full TS program analysis.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Path segments under apps/server/src that must go through the bus. */
export const BUS_ONLY_PATH_PREFIXES = Object.freeze([
  "routes/",
  "ai/",
  "worker/",
  "workers/",
] as const);

/**
 * Import path substrings that indicate a forbidden direct write dependency.
 * Matches relative imports like `../services/order-write` or `@laundry/server/repos/`.
 */
export const FORBIDDEN_IMPORT_PATTERNS = Object.freeze([
  /from\s+['"][^'"]*\/services\/[^'"]*write[^'"]*['"]/u,
  /from\s+['"][^'"]*\/services\/[^'"]*mutat[^'"]*['"]/u,
  /from\s+['"][^'"]*\/repos?\//u,
  /from\s+['"][^'"]*\/repositories\//u,
  /from\s+['"][^'"]*write-service[^'"]*['"]/u,
  /require\(\s*['"][^'"]*\/(services|repos?|repositories)\//u,
] as const);

export type BoundaryViolation = Readonly<{
  file: string;
  line: number;
  snippet: string;
  pattern: string;
}>;

export type BoundaryScanResult =
  | Readonly<{
      ok: true;
      scannedFiles: number;
    }>
  | Readonly<{
      ok: false;
      scannedFiles: number;
      violations: readonly BoundaryViolation[];
    }>;

/** True when relative path is under a bus-only prefix. */
export function isBusOnlyPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/gu, "/");
  return BUS_ONLY_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Scan one source string; returns violations (empty if clean). */
export function findForbiddenImports(
  source: string,
  fileLabel = "<memory>",
): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const lines = source.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
      if (pattern.test(line)) {
        violations.push(
          Object.freeze({
            file: fileLabel,
            line: i + 1,
            snippet: line.trim(),
            pattern: pattern.source,
          }),
        );
      }
    }
  }
  return Object.freeze(violations);
}

/** Recursively list .ts/.tsx files under dir. */
export function listSourceFiles(rootDir: string): readonly string[] {
  const out: string[] = [];
  walk(rootDir, out);
  return Object.freeze(out);
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
}

/**
 * Scan `srcRoot` for bus-only paths that import write services/repos.
 * Missing routes/ai/worker dirs are OK (scannedFiles = 0).
 */
export function scanImportBoundary(srcRoot: string): BoundaryScanResult {
  const allFiles = listSourceFiles(srcRoot);
  const targets = allFiles.filter((file) => {
    const rel = relative(srcRoot, file).replace(/\\/gu, "/");
    return isBusOnlyPath(rel);
  });

  const violations: BoundaryViolation[] = [];
  for (const file of targets) {
    const rel = relative(srcRoot, file).replace(/\\/gu, "/");
    const source = readFileSync(file, "utf8");
    violations.push(...findForbiddenImports(source, rel));
  }

  if (violations.length > 0) {
    return Object.freeze({
      ok: false as const,
      scannedFiles: targets.length,
      violations: Object.freeze(violations),
    });
  }
  return Object.freeze({ ok: true as const, scannedFiles: targets.length });
}
