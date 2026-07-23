/**
 * C1 registry loader — M1 first-wave command definitions from @laundry/contracts.
 * Handlers are registered separately; definitions alone are not executable.
 */

import { M1_FIRST_WAVE_DEFINITIONS, M2_SKELETON_DEFINITIONS } from "@laundry/contracts";
import type { CommandDefinition as ContractsCommandDefinition } from "@laundry/contracts";
import type { QueryDefinition } from "@laundry/contracts";
import type { z } from "zod";

import type {
  BusCommandDefinition,
  CommandHandler,
  CommandRegistry,
  RegisteredCommand,
} from "./types.js";

type AnyDefinition = ContractsCommandDefinition<z.ZodObject> | QueryDefinition<z.ZodObject>;

const isCommandDefinition = (def: AnyDefinition): def is ContractsCommandDefinition<z.ZodObject> =>
  def.kind === "command";

/** M1 A6 catalog + M2 order/print/customer/shift skeleton command definitions. */
export const DEFAULT_BUS_COMMAND_DEFINITIONS: readonly AnyDefinition[] = Object.freeze([
  ...M1_FIRST_WAVE_DEFINITIONS,
  ...M2_SKELETON_DEFINITIONS,
]);

export type MutableCommandRegistry = CommandRegistry &
  Readonly<{
    registerHandler: (name: string, handler: CommandHandler) => void;
  }>;

/**
 * Load command definitions into a mutable handler map.
 * Default: M1 first-wave + M2 order/print skeleton. Queries excluded.
 */
export function createM1CommandRegistry(
  definitions: readonly AnyDefinition[] = DEFAULT_BUS_COMMAND_DEFINITIONS,
): MutableCommandRegistry {
  const byName = new Map<string, { definition: BusCommandDefinition; handler?: CommandHandler }>();

  for (const def of definitions) {
    if (!isCommandDefinition(def)) continue;
    if (byName.has(def.name)) {
      throw new Error(`Duplicate command definition: ${def.name}`);
    }
    byName.set(def.name, { definition: def });
  }

  return {
    get(name: string): RegisteredCommand | undefined {
      const entry = byName.get(name);
      if (entry === undefined) return undefined;
      return entry.handler === undefined
        ? { definition: entry.definition }
        : { definition: entry.definition, handler: entry.handler };
    },
    names(): readonly string[] {
      return Object.freeze([...byName.keys()].sort());
    },
    registerHandler(name: string, handler: CommandHandler): void {
      const entry = byName.get(name);
      if (entry === undefined) {
        throw new Error(`Cannot register handler for unknown command: ${name}`);
      }
      entry.handler = handler;
    },
  };
}
