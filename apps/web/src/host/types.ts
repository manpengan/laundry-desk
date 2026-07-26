import type { AuthPort } from "../auth/AuthClient.js";
import type { CommandPort, QueryPort } from "../commands/types.js";

export type HealthReady = Readonly<{
  status: "ready";
}>;

export type HealthError = Readonly<{
  code: "SERVICE_UNAVAILABLE";
  message: string;
}>;

export type HealthResult =
  Readonly<{ ok: true; data: HealthReady }> | Readonly<{ ok: false; error: HealthError }>;

export type HealthPort = Readonly<{
  get: () => Promise<HealthResult>;
}>;

/** All renderer-visible capabilities. No credential accessor is exposed here. */
export type AppPorts = Readonly<{
  auth: AuthPort;
  command: CommandPort;
  query: QueryPort;
  health: HealthPort;
}>;
