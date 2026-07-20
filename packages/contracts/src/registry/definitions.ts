import { z } from "zod";

import {
  CommandMetadataSchema,
  QueryMetadataSchema,
  type CommandMetadata,
  type QueryMetadata,
  type Risk,
} from "./schemas.js";
import {
  captureInputIntegrity,
  cloneContractInput,
  createProtectedInputView,
  isSafeContractInput,
  resolveInputPath,
  validateSchemaMetadata,
} from "./input-schemas.js";

type ContractKind = "command" | "query";

declare const CONTRACT_DEFINITION_BRAND: unique symbol;

type ContractDefinitionBrand = Readonly<{
  [CONTRACT_DEFINITION_BRAND]: true;
}>;

type ContractInputMember<TInput extends z.ZodObject> = Readonly<{
  /**
   * Strict, recursively safe Zod input contract. Consumers must parse through
   * parseContractInput so provenance and schema integrity are checked first.
   */
  input: TInput;
}>;

export type ContractDefinition<
  TKind extends ContractKind,
  TInput extends z.ZodObject,
> = TKind extends "command"
  ? Readonly<CommandMetadata> & ContractInputMember<TInput> & ContractDefinitionBrand
  : Readonly<QueryMetadata> & ContractInputMember<TInput> & ContractDefinitionBrand;

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
  Omit<CommandMetadata, "kind"> & ContractInputMember<TInput>
>;

type QueryDefinitionInput<TInput extends z.ZodObject> = Readonly<
  Omit<QueryMetadata, "kind"> & ContractInputMember<TInput>
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

const StrictInputSchema = z.custom<z.ZodObject>((value) => value instanceof z.ZodObject, {
  message: "Input must be a classic ZodObject",
});

const CommandDefinitionInputSchema = z
  .object({ ...CommandCallerMetadataShape, input: StrictInputSchema })
  .strict();

const QueryDefinitionInputSchema = z
  .object({ ...QueryCallerMetadataShape, input: StrictInputSchema })
  .strict();

type DefinitionRegistration = Readonly<{
  schema: z.ZodObject;
  verify: () => boolean;
}>;

const registeredDefinitions = new WeakMap<object, DefinitionRegistration>();

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

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
  try {
    const snapshot = cloneContractInput(input);
    if (!isSafeContractInput(snapshot)) {
      inputPathError(
        ["input"],
        "Input and every nested object must be strict and may not contain unsafe schemas",
      );
    }
    validateSchemaMetadata(snapshot);
    return snapshot as TInput;
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    return inputPathError(
      ["input"],
      error instanceof Error ? error.message : "Schema metadata is not JSON-compatible",
    );
  }
};

const registerDefinition = <TDefinition extends object>(
  definition: object,
  registration: DefinitionRegistration,
): TDefinition => {
  registeredDefinitions.set(definition, registration);
  // The private brand denotes membership in registeredDefinitions; factories are its only writers.
  return definition as TDefinition;
};

const inputPathError = (path: readonly PropertyKey[], message: string): never => {
  throw new z.ZodError([
    {
      code: "custom",
      message,
      path: path.map(String),
    },
  ]);
};

const requireInputPath = (
  input: z.ZodObject,
  pointer: string,
  issuePath: readonly PropertyKey[],
  expected?: new (...args: never[]) => z.ZodType,
): void => {
  const resolution = resolveInputPath(input, pointer);
  if (resolution.status === "missing") {
    inputPathError(issuePath, "Declared input path does not exist in the input schema");
  }
  if (
    resolution.status === "resolved" &&
    expected !== undefined &&
    !(resolution.schema instanceof expected)
  ) {
    inputPathError(issuePath, "Declared input path has an incompatible schema type");
  }
};

const validateCommandInputPaths = (metadata: CommandMetadata, input: z.ZodObject): void => {
  metadata.input_redaction.forEach((rule, index) =>
    requireInputPath(input, rule.path, ["input_redaction", index, "path"]),
  );
  const measures = metadata.size_measures;
  if (measures?.batch?.kind === "array_length") {
    requireInputPath(input, measures.batch.path, ["size_measures", "batch", "path"], z.ZodArray);
  }
  if (measures?.batch?.kind === "numeric_sum") {
    requireInputPath(
      input,
      `${measures.batch.path}/0/${measures.batch.field}`,
      ["size_measures", "batch", "path"],
      z.ZodNumber,
    );
  }
  if (measures?.amount?.kind === "field") {
    requireInputPath(input, measures.amount.path, ["size_measures", "amount", "path"], z.ZodNumber);
  }
  if (measures?.amount?.kind === "numeric_sum") {
    requireInputPath(
      input,
      `${measures.amount.path}/0/${measures.amount.field}`,
      ["size_measures", "amount", "path"],
      z.ZodNumber,
    );
  }
};

const createRegisteredDefinition = <TDefinition extends object, TInput extends z.ZodObject>(
  metadata: object,
  schema: TInput,
): TDefinition => {
  const verify = captureInputIntegrity(schema);
  const result = Object.freeze({
    ...copyAndDeepFreeze(metadata),
    input: createProtectedInputView(schema, verify),
  });
  return registerDefinition<TDefinition>(result, { schema, verify });
};

const createCommandDefinition = <TInput extends z.ZodObject>(
  definition: CommandDefinitionInput<TInput>,
): CommandDefinition<TInput> => {
  const parsedEnvelope = CommandDefinitionInputSchema.parse(definition);
  const callerMetadata = omitProperty(parsedEnvelope, "input");
  const metadata = CommandMetadataSchema.parse({ ...callerMetadata, kind: "command" });
  const input = snapshotInput<TInput>(parsedEnvelope.input);
  validateCommandInputPaths(metadata, input);

  return createRegisteredDefinition<CommandDefinition<TInput>, TInput>(metadata, input);
};

const createQueryDefinition = <TInput extends z.ZodObject>(
  definition: QueryDefinitionInput<TInput>,
): QueryDefinition<TInput> => {
  const parsedEnvelope = QueryDefinitionInputSchema.parse(definition);
  const callerMetadata = omitProperty(parsedEnvelope, "input");
  const metadata = QueryMetadataSchema.parse({ ...callerMetadata, kind: "query" });
  const input = snapshotInput<TInput>(parsedEnvelope.input);
  metadata.input_redaction.forEach((rule, index) =>
    requireInputPath(input, rule.path, ["input_redaction", index, "path"]),
  );

  return createRegisteredDefinition<QueryDefinition<TInput>, TInput>(metadata, input);
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
  typeof value === "object" &&
  value !== null &&
  (registeredDefinitions.get(value)?.verify() ?? false);

/**
 * C1 input boundary: verifies registry provenance and schema integrity before parsing raw input.
 * This is the only supported parsing entry point for registered command/query definitions.
 */
export const parseContractInput = <TInput extends z.ZodObject>(
  definition: ContractDefinition<ContractKind, TInput>,
  rawInput: unknown,
): Promise<z.output<TInput>> => {
  const registration = registeredDefinitions.get(definition);
  if (registration === undefined || !registration.verify()) {
    return Promise.reject(new Error("Contract input schema integrity check failed"));
  }
  return z
    .parseAsync(registration.schema, rawInput)
    .then((parsed) => {
      if (!registration.verify()) {
        throw new Error("Contract input schema integrity check failed");
      }
      return parsed as z.output<TInput>;
    })
    .catch((error: unknown) => {
      if (!registration.verify()) {
        throw new Error("Contract input schema integrity check failed");
      }
      throw error;
    });
};

/** C4 guard: registry provenance is required and R5 commands are mechanically excluded. */
export const isAiProjectableDefinition = <TInput extends z.ZodObject>(
  definition: ContractDefinition<ContractKind, TInput>,
): definition is AiProjectableDefinition<TInput> =>
  isContractDefinition(definition) && definition.risk !== "R5";
