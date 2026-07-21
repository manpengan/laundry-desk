/**
 * C1 command bus types.
 * Bus is the sole write entry for routes / AI tools / workers (ADR-05 #1).
 */

import type {
  CommandDefinition as ContractsCommandDefinition,
  CommandError,
} from "@laundry/contracts";
import type { z } from "zod";
import type { SqlClient, TenantContext, Uuid } from "../db/types.js";

/** M1 bus registers classic ZodObject command definitions only. */
export type BusCommandDefinition = ContractsCommandDefinition<z.ZodObject>;

export type CommandVia = "ui" | "ai" | "automation" | "edge_replay";

/** Authenticated actor (C6/C8 injects; never trust wire-reported staff). */
export type ActorContext = Readonly<{
  staffId: Uuid;
  deviceId: Uuid | null;
  via: CommandVia;
}>;

/** Caller-facing request assembled after auth (C8) or test harness. */
export type CommandRequest = Readonly<{
  name: string;
  version: string;
  input: unknown;
  dryRun: boolean;
  idempotencyKey?: string;
  confirmRef?: string;
}>;

/**
 * Bus result mirrors A2 CommandResponse shape.
 * `result` stays `unknown` until concrete handlers freeze JSON payloads.
 */
export type CommandResult =
  | Readonly<{
      ok: true;
      data: Readonly<{ execution: "preview" | "executed"; result: unknown }>;
    }>
  | Readonly<{ ok: false; error: CommandError }>;

export type DomainEvent = Readonly<{
  type: string;
  payload: Readonly<Record<string, unknown>>;
}>;

/** After-commit side effects only — never invoked inside the DB transaction. */
export type EventBus = Readonly<{
  publish: (events: readonly DomainEvent[]) => void | Promise<void>;
}>;

export type AuditWriteInput = Readonly<{
  entity?: string;
  entityId?: string;
  beforeJson?: string;
  afterJson?: string;
  ip?: string;
}>;

/**
 * Handler outcome after successful chain validation.
 * `audit` is written in the same transaction as business mutations.
 * `events` are queued for after-commit publish.
 */
export type HandlerOutcome = Readonly<{
  result: unknown;
  audit?: AuditWriteInput;
  events?: readonly DomainEvent[];
}>;

export type HandlerContext = Readonly<{
  client: SqlClient;
  tenant: TenantContext;
  actor: ActorContext;
  request: CommandRequest;
  parsed: unknown;
}>;

/** Business mutation handler — runs only when chain passes and dry_run is false. */
export type CommandHandler = (ctx: HandlerContext) => Promise<HandlerOutcome>;

export type RegisteredCommand = Readonly<{
  definition: BusCommandDefinition;
  handler?: CommandHandler;
}>;

export type CommandRegistry = Readonly<{
  get: (name: string) => RegisteredCommand | undefined;
  names: () => readonly string[];
}>;

export type IdempotencyStore = Readonly<{
  get: (tenant: TenantContext, command: string, key: string) => Promise<CommandResult | null>;
  put: (
    tenant: TenantContext,
    command: string,
    key: string,
    result: CommandResult,
  ) => Promise<void>;
}>;

/** Runtime context shared by chain adapter + executor. */
export type BusContext = Readonly<{
  tenant: TenantContext;
  actor: ActorContext;
  request: CommandRequest;
  definition: BusCommandDefinition;
}>;

export type ChainError = CommandError;

export type { CommandError, SqlClient, TenantContext, Uuid };
