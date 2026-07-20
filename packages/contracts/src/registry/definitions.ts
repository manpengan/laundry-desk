import { z, type ZodType } from "zod";

import {
  CommandMetadataSchema,
  QueryMetadataSchema,
  type CommandMetadata,
  type QueryMetadata,
  type ResultRedactionRule,
} from "./schemas.js";

const DefinitionEnvelopeSchema = z.object({ input: z.instanceof(z.ZodType) }).passthrough();

export type ContractDefinition<
  TKind extends "command" | "query",
  TInput extends ZodType,
> = Readonly<
  (TKind extends "command" ? CommandMetadata : QueryMetadata) & {
    readonly input: TInput;
  }
>;

export type CommandDefinition<TInput extends ZodType> = ContractDefinition<"command", TInput>;
export type QueryDefinition<TInput extends ZodType> = ContractDefinition<"query", TInput>;
export type InferContractInput<TDefinition extends { readonly input: ZodType }> = z.input<
  TDefinition["input"]
>;
export type InferContractOutput<TDefinition extends { readonly input: ZodType }> = z.output<
  TDefinition["input"]
>;

type CommandDefinitionInput<TInput extends ZodType> = Readonly<
  Omit<CommandMetadata, "kind"> & { readonly input: TInput }
>;

type QueryDefinitionInput<TInput extends ZodType> = Readonly<
  Omit<QueryMetadata, "kind"> & { readonly input: TInput }
>;

const freezeRedactionRule = (rule: ResultRedactionRule): ResultRedactionRule =>
  Object.freeze({ ...rule });

const freezeCommandMetadata = (metadata: CommandMetadata): CommandMetadata =>
  Object.freeze({
    ...metadata,
    invariants: Object.freeze([...metadata.invariants]),
    sideEffects: Object.freeze([...metadata.sideEffects]),
    result_redaction: Object.freeze(metadata.result_redaction.map(freezeRedactionRule)),
  });

const freezeQueryMetadata = (metadata: QueryMetadata): QueryMetadata =>
  Object.freeze({
    ...metadata,
    invariants: Object.freeze([...metadata.invariants]),
    sideEffects: Object.freeze([...metadata.sideEffects]),
    result_redaction: Object.freeze(metadata.result_redaction.map(freezeRedactionRule)),
  });

const validateDefinitionEnvelope = (definition: unknown): void => {
  DefinitionEnvelopeSchema.parse(definition);
};

export const defineCommand = <TInput extends ZodType>(
  definition: CommandDefinitionInput<TInput>,
): CommandDefinition<TInput> => {
  validateDefinitionEnvelope(definition);
  const { input, ...metadata } = definition;
  const parsedMetadata = CommandMetadataSchema.parse({
    ...metadata,
    kind: "command",
  });

  return Object.freeze({ ...freezeCommandMetadata(parsedMetadata), input });
};

export const defineQuery = <TInput extends ZodType>(
  definition: QueryDefinitionInput<TInput>,
): QueryDefinition<TInput> => {
  validateDefinitionEnvelope(definition);
  const { input, ...metadata } = definition;
  const parsedMetadata = QueryMetadataSchema.parse({
    ...metadata,
    kind: "query",
  });

  return Object.freeze({ ...freezeQueryMetadata(parsedMetadata), input });
};
