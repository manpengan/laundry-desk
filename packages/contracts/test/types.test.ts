import { expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  isAiProjectableDefinition,
  type ContractDefinition,
  type InferContractInput,
  type InferContractOutput,
} from "../src/index.js";

const metadata = {
  name: "orders.transform",
  version: "1.0.0",
  description: "Transform an order quantity",
  description_llm: "Transform one validated order quantity.",
  risk: "R1" as const,
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied" as const,
  data_classification: "internal" as const,
  input_redaction: [],
  result_redaction: [],
};

it("preserves pre-transform input and parsed output types", () => {
  const definition = defineCommand({
    ...metadata,
    input: z.strictObject({ quantity: z.string().transform(Number) }),
  });

  expectTypeOf<InferContractInput<typeof definition>>().toEqualTypeOf<{ quantity: string }>();
  expectTypeOf<InferContractOutput<typeof definition>>().toEqualTypeOf<{ quantity: number }>();
});

it("preserves discriminated query literals", () => {
  const input = z.strictObject({ orderId: z.string() });
  const command = defineCommand({ ...metadata, input });
  const query = defineQuery({
    ...metadata,
    name: "orders.get",
    input,
    idempotent: true,
    max_result_rows: 1,
  });
  const inspect = (definition: typeof command | typeof query): void => {
    if (definition.kind === "query") {
      expectTypeOf(definition.risk).toEqualTypeOf<"R0" | "R1" | "R2">();
      expectTypeOf(definition.idempotent).toEqualTypeOf<true>();
      expectTypeOf(definition.offline_mode).toEqualTypeOf<"denied">();
    }
  };

  inspect(command);
  inspect(query);
});

it("prevents structural definition forgery at compile time", () => {
  const input = z.strictObject({ orderId: z.string() });
  const plainObject = { ...metadata, kind: "command" as const, input };

  // @ts-expect-error Contract definitions carry a package-private unique brand.
  const forged: ContractDefinition<"command", typeof input> = plainObject;

  expectTypeOf(forged).toMatchTypeOf<ContractDefinition<"command", typeof input>>();
});

it("rejects a caller-supplied kind at compile time", () => {
  const input = z.strictObject({ orderId: z.string() });

  if (Math.random() < 0) {
    // @ts-expect-error Factories own the discriminator, even when the value matches.
    defineCommand({ ...metadata, input, kind: "command" });
    // @ts-expect-error Factories own the discriminator, including conflicting values.
    defineQuery({ ...metadata, input, kind: "command", max_result_rows: 1 });
  }
});

it("narrows AI-projectable definitions away from R5 and secret data", () => {
  const inspect = (definition: ContractDefinition<"command" | "query", z.ZodObject>): void => {
    if (isAiProjectableDefinition(definition)) {
      expectTypeOf(definition.risk).toEqualTypeOf<"R0" | "R1" | "R2" | "R3" | "R4">();
      expectTypeOf(definition.data_classification).toEqualTypeOf<"public" | "internal" | "pii">();
    }
  };

  inspect(
    defineCommand({
      ...metadata,
      input: z.strictObject({ orderId: z.string() }),
    }),
  );
});
