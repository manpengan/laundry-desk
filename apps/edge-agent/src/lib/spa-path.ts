import { isAbsolute, join, normalize, relative } from "node:path";

/**
 * Resolve a URL path under the built-in SPA root.
 * Rejects traversal outside spaRoot (including absolute escapes).
 */
export function resolveSpaPath(spaRoot: string, urlPath: string): string | null {
  const trimmed = urlPath === "/" || urlPath === "" ? "index.html" : urlPath.replace(/^\//, "");
  if (trimmed.includes("\0")) return null;

  const full = normalize(join(spaRoot, trimmed));
  const rel = relative(spaRoot, full);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.includes("..")) {
    return null;
  }
  return full;
}
