/** Replaced only in dist by the explicit package-time Runtime binding step. Never reads a user manifest as a trust root. */
export type RuntimeMaintenanceBinding = Readonly<{
  manifest_sha256: string;
  entry_sha256: string;
  entry_size: number;
  source_git_sha: string;
  trust_script: string;
}>;
export const RUNTIME_MAINTENANCE_BINDING: RuntimeMaintenanceBinding | null = null;
