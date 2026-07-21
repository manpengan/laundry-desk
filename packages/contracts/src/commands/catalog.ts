import type { CommandDefinition, QueryDefinition } from "../registry/definitions.js";
import { IDENTITY_COMMANDS, IDENTITY_COMMAND_NAMES } from "./identity.js";
import { PLATFORM_COMMANDS, PLATFORM_DEFINITIONS, PLATFORM_QUERIES } from "./platform.js";
import type { z } from "zod";

/** M1 first-wave registered definitions (A6). */
export const M1_FIRST_WAVE_DEFINITIONS: readonly (
  CommandDefinition<z.ZodObject> | QueryDefinition<z.ZodObject>
)[] = Object.freeze([...IDENTITY_COMMANDS, ...PLATFORM_DEFINITIONS]);

export const M1_FIRST_WAVE_COMMAND_NAMES = Object.freeze([
  ...IDENTITY_COMMAND_NAMES,
  ...PLATFORM_COMMANDS.map((command) => command.name),
] as const);

export const M1_FIRST_WAVE_QUERY_NAMES = Object.freeze(PLATFORM_QUERIES.map((query) => query.name));
