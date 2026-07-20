import { z } from "zod";

import {
  CommandMetadataSchema,
  QueryMetadataSchema,
  type CommandMetadata,
  type QueryMetadata,
  type Risk,
} from "./schemas.js";

type ContractKind = "command" | "query";

declare const CONTRACT_DEFINITION_BRAND: unique symbol;

type ContractDefinitionBrand = Readonly<{
  [CONTRACT_DEFINITION_BRAND]: true;
}>;

export type ContractDefinition<
  TKind extends ContractKind,
  TInput extends z.ZodObject,
> = TKind extends "command"
  ? Readonly<CommandMetadata & { readonly input: TInput }> & ContractDefinitionBrand
  : Readonly<QueryMetadata & { readonly input: TInput }> & ContractDefinitionBrand;

export type CommandDefinition<TInput extends z.ZodObject> = ContractDefinition<"command", TInput>;
export type QueryDefinition<TInput extends z.ZodObject> = ContractDefinition<"query", TInput>;
export type AiProjectableDefinition<TInput extends z.ZodObject = z.ZodObject> =
  (CommandDefinition<TInput> & { readonly risk: Exclude<Risk, "R5"> }) | QueryDefinition<TInput>;

export type InferContractInput<TDefinition extends { readonly input: z.ZodType }> = z.input<
  TDefinition["input"]
>;
export type InferContractOutput<TDefinition extends { readonly input: z.ZodType }> = z.output<
  TDefinition["input"]
>;

type CommandDefinitionInput<TInput extends z.ZodObject> = Readonly<
  Omit<CommandMetadata, "kind"> & { readonly input: TInput }
>;

type QueryDefinitionInput<TInput extends z.ZodObject> = Readonly<
  Omit<QueryMetadata, "kind"> & { readonly input: TInput }
>;

const omitProperty = <TRecord extends object, TKey extends keyof TRecord>(
  record: TRecord,
  key: TKey,
): Omit<TRecord, TKey> => {
  const copy = { ...record };
  Reflect.deleteProperty(copy, key);
  return copy;
};

const CommandCallerMetadataShape = omitProperty(CommandMetadataSchema.shape, "kind");
const QueryCallerMetadataShape = omitProperty(QueryMetadataSchema.shape, "kind");

const isStrictZodObject = (value: unknown): value is z.ZodObject =>
  value instanceof z.ZodObject && value.def.catchall instanceof z.ZodNever;

const StrictInputSchema = z.custom<z.ZodObject>(isStrictZodObject, {
  message: "Input must be a genuine strict Zod object schema",
});

const CommandDefinitionInputSchema = z
  .object({ ...CommandCallerMetadataShape, input: StrictInputSchema })
  .strict();

const QueryDefinitionInputSchema = z
  .object({ ...QueryCallerMetadataShape, input: StrictInputSchema })
  .strict();

const registeredDefinitions = new WeakSet<object>();

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const copyAndDeepFreeze = <T>(value: T): T => {
  if (Array.isArray(value)) {
    // Metadata schemas contain JSON-compatible arrays; mapping creates a caller-independent copy.
    return Object.freeze(value.map((item) => copyAndDeepFreeze(item))) as T;
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value).map(([key, entry]) => [key, copyAndDeepFreeze(entry)]);
    // The reconstructed record has the same validated keys and values as T.
    return Object.freeze(Object.fromEntries(entries)) as T;
  }
  return value;
};

const snapshotInput = <TInput extends z.ZodObject>(input: z.ZodObject): TInput => {
  const snapshot = input.safeExtend({});
  // Zod builds an extended shape lazily. Materializing it severs later caller shape replacement.
  void snapshot.shape;
  const metadata = input.meta();
  const snapshotWithMetadata = metadata === undefined ? snapshot : snapshot.meta(metadata);

  // safeExtend({}) preserves the original shape/config/checks and therefore its input/output type.
  return snapshotWithMetadata as TInput;
};

const registerDefinition = <TDefinition extends object>(definition: object): TDefinition => {
  registeredDefinitions.add(definition);
  // The private brand denotes membership in registeredDefinitions; factories are its only writers.
  return definition as TDefinition;
};

const createCommandDefinition = <TInput extends z.ZodObject>(
  definition: CommandDefinitionInput<TInput>,
): CommandDefinition<TInput> => {
  const parsedEnvelope = CommandDefinitionInputSchema.parse(definition);
  const callerMetadata = omitProperty(parsedEnvelope, "input");
  const metadata = CommandMetadataSchema.parse({ ...callerMetadata, kind: "command" });
  const result = Object.freeze({
    ...copyAndDeepFreeze(metadata),
    input: snapshotInput<TInput>(parsedEnvelope.input),
  });

  return registerDefinition<CommandDefinition<TInput>>(result);
};

const createQueryDefinition = <TInput extends z.ZodObject>(
  definition: QueryDefinitionInput<TInput>,
): QueryDefinition<TInput> => {
  const parsedEnvelope = QueryDefinitionInputSchema.parse(definition);
  const callerMetadata = omitProperty(parsedEnvelope, "input");
  const metadata = QueryMetadataSchema.parse({ ...callerMetadata, kind: "query" });
  const result = Object.freeze({
    ...copyAndDeepFreeze(metadata),
    input: snapshotInput<TInput>(parsedEnvelope.input),
  });

  return registerDefinition<QueryDefinition<TInput>>(result);
};

/** A1 factory: validates and registers one immutable command definition. */
export const defineCommand = <TInput extends z.ZodObject>(
  definition: CommandDefinitionInput<TInput>,
): CommandDefinition<TInput> => createCommandDefinition(definition);

/** A1 factory: validates and registers one immutable query definition. */
export const defineQuery = <TInput extends z.ZodObject>(
  definition: QueryDefinitionInput<TInput>,
): QueryDefinition<TInput> => createQueryDefinition(definition);

/** Returns true only for objects created by this module's definition factories. */
export const isContractDefinition = (
  value: unknown,
): value is ContractDefinition<ContractKind, z.ZodObject> =>
  typeof value === "object" && value !== null && registeredDefinitions.has(value);

/** C4 guard: registry provenance is required and R5 commands are mechanically excluded. */
export const isAiProjectableDefinition = <TInput extends z.ZodObject>(
  definition: ContractDefinition<ContractKind, TInput>,
): definition is AiProjectableDefinition<TInput> =>
  isContractDefinition(definition) && definition.risk !== "R5";
