import { z } from "zod";

import { isContractDefinition, sealRegisteredCommandDefinitions } from "../registry/definitions.js";
import { CommandNameSchema } from "../registry/primitives.js";

export type OfflineGrantAuthorizationSummary = Readonly<{
  allowed_commands: readonly string[];
  primary_lease_commands: readonly string[];
}>;

export type OfflineGrantDefinitionReference = Readonly<{
  name: string;
  version: string;
}>;

declare const OFFLINE_GRANT_REGISTRY_SNAPSHOT_BRAND: unique symbol;

export type OfflineGrantRegistrySnapshot = Readonly<{
  definition_refs: readonly OfflineGrantDefinitionReference[];
  [OFFLINE_GRANT_REGISTRY_SNAPSHOT_BRAND]: true;
}>;

type OfflineMode = "denied" | "grant" | "primary_lease";
type SnapshotCommand = Readonly<{ name: string; version: string; offline_mode: OfflineMode }>;
type SnapshotRegistration = Readonly<{
  definitionsByName: ReadonlyMap<string, readonly SnapshotCommand[]>;
}>;

const snapshotRegistrations = new WeakMap<object, SnapshotRegistration>();

const AllowedCommandsSchema = z
  .array(CommandNameSchema)
  .min(1)
  .refine((commands) => new Set(commands).size === commands.length, {
    message: "Grant command names must be unique",
  });

const failGrantValidation = (command: string, message: string): never => {
  throw new z.ZodError([
    {
      code: "custom",
      message,
      path: ["payload", "allowed_commands", command],
    },
  ]);
};

const snapshotCommands = (definitions: readonly unknown[]): readonly SnapshotCommand[] =>
  Object.freeze(
    definitions.map((definition) => {
      if (!isContractDefinition(definition) || definition.kind !== "command") {
        throw new TypeError("Offline grant registry contains an unregistered command definition");
      }
      return Object.freeze({
        name: definition.name,
        version: definition.version,
        offline_mode: definition.offline_mode,
      });
    }),
  );

const groupCommands = (
  commands: readonly SnapshotCommand[],
): ReadonlyMap<string, readonly SnapshotCommand[]> => {
  const mutableGroups = new Map<string, readonly SnapshotCommand[]>();
  commands.forEach((command) => {
    mutableGroups.set(
      command.name,
      Object.freeze([...(mutableGroups.get(command.name) ?? []), command]),
    );
  });
  return new Map(mutableGroups);
};

/**
 * Atomically seals and snapshots every A1 command registered in this module instance. This API
 * accepts no caller-owned definition/manifest arrays: a caller cannot cherry-pick a permissive
 * version, and `defineCommand()` fails closed after the first snapshot seals the registry.
 */
export function createOfflineGrantRegistrySnapshot(): OfflineGrantRegistrySnapshot {
  if (arguments.length !== 0) {
    throw new TypeError("Offline grant snapshot does not accept caller-owned registry subsets");
  }
  const commands = snapshotCommands(sealRegisteredCommandDefinitions());
  const references = commands.map(({ name, version }) => Object.freeze({ name, version }));
  const referenceKeys = references.map(({ name, version }) => `${name}@${version}`);
  if (references.length === 0 || new Set(referenceKeys).size !== references.length) {
    throw new TypeError("Offline grant registry must contain unique registered command versions");
  }

  const snapshot = Object.freeze({
    definition_refs: Object.freeze([...references]),
  }) as OfflineGrantRegistrySnapshot;
  snapshotRegistrations.set(
    snapshot,
    Object.freeze({ definitionsByName: groupCommands(commands) }),
  );
  return snapshot;
}

export const isOfflineGrantRegistrySnapshot = (
  value: unknown,
): value is OfflineGrantRegistrySnapshot =>
  typeof value === "object" && value !== null && snapshotRegistrations.has(value);

const requireSnapshotRegistration = (snapshot: unknown): SnapshotRegistration => {
  if (!isOfflineGrantRegistrySnapshot(snapshot)) {
    throw new TypeError("Offline grant validation requires registry snapshot provenance");
  }
  const registration = snapshotRegistrations.get(snapshot);
  if (registration === undefined) {
    throw new TypeError("Offline grant validation requires registry snapshot provenance");
  }
  return registration;
};

const commandRequiresPrimaryLease = (
  command: string,
  definitions: readonly SnapshotCommand[] | undefined,
): boolean => {
  if (definitions === undefined || definitions.length === 0) {
    return failGrantValidation(command, `Command ${command} is not registered`);
  }
  if (definitions.some((definition) => definition.offline_mode === "denied")) {
    return failGrantValidation(command, `Command ${command} offline_mode is denied`);
  }
  return definitions.some((definition) => definition.offline_mode === "primary_lease");
};

/**
 * A4 §2.4: dynamic grants may only tighten A1's sealed registered offline upper bound. A command
 * declared `primary_lease` remains in the summary so Edge/C1 must additionally prove a valid lease.
 */
export const validateOfflineGrantAllowedCommands = (
  allowedCommands: readonly string[],
  snapshot: OfflineGrantRegistrySnapshot,
): OfflineGrantAuthorizationSummary => {
  const commands = AllowedCommandsSchema.parse(allowedCommands);
  const { definitionsByName } = requireSnapshotRegistration(snapshot);
  const primaryLeaseCommands = commands.filter((command) =>
    commandRequiresPrimaryLease(command, definitionsByName.get(command)),
  );

  return Object.freeze({
    allowed_commands: Object.freeze([...commands]),
    primary_lease_commands: Object.freeze(primaryLeaseCommands),
  });
};
