/**
 * M1 query registry — A6 query definitions from @laundry/contracts.
 * Handlers registered separately; definitions alone are not executable.
 */

import { M1_FIRST_WAVE_DEFINITIONS } from "@laundry/contracts";
import type { QueryDefinition } from "@laundry/contracts";
import type { z } from "zod";

import type { CommandHandler } from "./types.js";

export type BusQueryDefinition = QueryDefinition<z.ZodObject>;

export type RegisteredQuery = Readonly<{
  definition: BusQueryDefinition;
  handler?: CommandHandler;
}>;

export type QueryRegistry = Readonly<{
  get: (name: string) => RegisteredQuery | undefined;
  names: () => readonly string[];
}>;

export type MutableQueryRegistry = QueryRegistry &
  Readonly<{
    registerHandler: (name: string, handler: CommandHandler) => void;
  }>;

type AnyDefinition = { kind: string; name: string };

const isQueryDefinition = (def: AnyDefinition): def is BusQueryDefinition => def.kind === "query";

/**
 * Load frozen M1 first-wave query definitions into a mutable handler map.
 * Commands are excluded — use createM1CommandRegistry for writes.
 */
export function createM1QueryRegistry(
  definitions: readonly AnyDefinition[] = M1_FIRST_WAVE_DEFINITIONS as readonly AnyDefinition[],
): MutableQueryRegistry {
  const byName = new Map<string, { definition: BusQueryDefinition; handler?: CommandHandler }>();

  for (const def of definitions) {
    if (!isQueryDefinition(def)) continue;
    if (byName.has(def.name)) {
      throw new Error(`Duplicate query definition: ${def.name}`);
    }
    byName.set(def.name, { definition: def });
  }

  return {
    get(name: string): RegisteredQuery | undefined {
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
        throw new Error(`Cannot register handler for unknown query: ${name}`);
      }
      entry.handler = handler;
    },
  };
}
