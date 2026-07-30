const SEMVER = /^(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})$/u;

export function isSemVer(value: string): boolean {
  return SEMVER.test(value);
}

function parseVersion(value: string): readonly [number, number, number] {
  if (!isSemVer(value)) {
    throw new TypeError("version must be an exact major.minor.patch triple");
  }
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new TypeError("version components must be safe integers");
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Compare exact `major.minor.patch` versions without silently accepting malformed input. */
export function compareVersion(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function isBelowMinSecure(version: string, minSecureVersion: string): boolean {
  return compareVersion(version, minSecureVersion) < 0;
}
