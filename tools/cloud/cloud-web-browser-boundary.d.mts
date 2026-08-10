export const CLOUD_WEB_ORIGIN: "https://desk.manpengan.xyz";

export type CloudBrowserPrincipal = Readonly<{
  username: string;
  displayName: string;
  password: string;
  pin: string;
}>;

export type CloudBrowserEnvironment = Readonly<{
  origin: typeof CLOUD_WEB_ORIGIN;
  machineJson: boolean;
  credentials: Readonly<{
    admin: CloudBrowserPrincipal;
    approver: CloudBrowserPrincipal;
  }>;
}>;

export function assertCloudBrowserConfiguration(
  env?: NodeJS.ProcessEnv,
): Readonly<{ origin: typeof CLOUD_WEB_ORIGIN; enabled: boolean; machineJson: boolean }>;

export function cloudBrowserMachineJsonRequested(env?: NodeJS.ProcessEnv): boolean;

export function loadCloudBrowserEnvironment(env?: NodeJS.ProcessEnv): CloudBrowserEnvironment;

export function createCloudBrowserRun(
  options?: Readonly<{
    now?: () => Date;
    randomUUID?: () => string;
  }>,
): Readonly<{
  runId: string;
}>;
