export type CanonicalAppTreeDescriptor = Readonly<{
  name: string;
  root_mode: number;
  entry_count: number;
  size_bytes: number;
  tree_sha256: string;
}>;

export function describeCanonicalAppTree(appPath: string): Promise<CanonicalAppTreeDescriptor>;
export function readBoundedRealFile(
  path: string,
  label: string,
  maximumBytes: number,
  options?: Readonly<{ requiredMode?: number; afterOpen?: () => Promise<void> }>,
): Promise<Buffer>;
export function describeReleaseArtifact(
  path: string,
  kind: "dmg" | "zip",
): Promise<Readonly<{ kind: "dmg" | "zip"; name: string; size_bytes: number; sha256: string }>>;
export function sealReleaseTreePermissions(paths: readonly string[]): Promise<void>;
export function createReleaseTreeVersion(root: string): Promise<readonly unknown[]>;
export function assertReleaseTreeVersion(root: string, expected: readonly unknown[]): Promise<void>;
export function isCanonicalAppTreeDescriptor(candidate: unknown): boolean;
