/** Compare dotted semver-ish `major.minor.patch` (missing parts = 0). */
export function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number(p) || 0);
  const pb = b.split(".").map((p) => Number(p) || 0);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function isBelowMinSecure(version: string, minSecureVersion: string): boolean {
  return compareVersion(version, minSecureVersion) < 0;
}
