import type { ZodType } from "zod";

import { CommandMetadataSchema, type CommandMetadata } from "./schemas.js";

export type CommandDefinition<TInput extends ZodType> = Readonly<
  CommandMetadata & { readonly input: TInput }
>;

export type CommandDefinitionInput<TInput extends ZodType> = Readonly<
  Omit<CommandMetadata, "kind"> & { readonly input: TInput }
>;

export const defineCommand = <TInput extends ZodType>(
  definition: CommandDefinitionInput<TInput>,
): CommandDefinition<TInput> => {
  const { input, ...metadata } = definition;
  const parsedMetadata = CommandMetadataSchema.parse({
    ...metadata,
    kind: "command",
  });

  return { ...parsedMetadata, input };
};
