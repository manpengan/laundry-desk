import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  isAiProjectableDefinition,
  parseContractInput,
  validateStricterLimitOverride,
  type CommandDefinition,
  type ContractDefinition,
} from "../src/index.js";

const input = z.strictObject({ order_ids: z.array(z.string().uuid()), amount_cents: z.number() });

const command = defineCommand({
  name: "orders.cancel_many",
  version: "1.0.0",
  description: "Cancel several orders",
  description_llm: "Cancel validated orders within declared limits.",
  input,
  risk: "R3",
  invariants: ["orders.cancelable"],
  idempotent: true,
  sideEffects: ["orders.status_changed"],
  offline_mode: "grant",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  size_measures: {
    batch: { kind: "array_length", path: "/order_ids" },
    amount: { kind: "field", path: "/amount_cents" },
  },
  hard_limits: { max_batch: 20, max_amount_cents: 100_000 },
  risk_escalation: { max_batch: 10, max_amount_cents: 50_000 },
});

const query = defineQuery({
  name: "orders.list",
  version: "1.0.0",
  description: "List orders",
  description_llm: "List a bounded set of orders.",
  input: z.strictObject({ limit: z.number().int().positive() }),
  risk: "R1",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 100,
});

describe("C1 command-bus consumer", () => {
  const execute = <TInput extends z.ZodObject>(
    definition: CommandDefinition<TInput>,
    rawInput: unknown,
  ): Promise<z.output<TInput>> => parseContractInput(definition, rawInput);

  it("validates through the preserved input schema and reads executable bindings", async () => {
    const parsed = await execute(command, {
      order_ids: [crypto.randomUUID()],
      amount_cents: 1_000,
    });

    expect(parsed.amount_cents).toBe(1_000);
    expect(command.invariants).toEqual(["orders.cancelable"]);
    expect(command.sideEffects).toEqual(["orders.status_changed"]);
  });
});

describe("C4 tool-registry consumer", () => {
  const project = (
    definition: ContractDefinition<"command" | "query", z.ZodObject>,
  ): Readonly<{ name: string; description: string }> | undefined =>
    isAiProjectableDefinition(definition)
      ? Object.freeze({ name: definition.name, description: definition.description_llm })
      : undefined;

  it("projects supported definitions through the R5 guard", () => {
    expect(project(command)).toEqual({
      name: "orders.cancel_many",
      description: "Cancel validated orders within declared limits.",
    });
    expect(project(query)).toEqual({
      name: "orders.list",
      description: "List a bounded set of orders.",
    });
  });
});

describe("C5 policy consumer", () => {
  it("uses typed factory limits and accepts only a stricter organization override", () => {
    const merged = validateStricterLimitOverride(
      {
        hard_limits: command.hard_limits,
        risk_escalation: command.risk_escalation,
      },
      {
        hard_limits: { max_batch: 15 },
        risk_escalation: { max_batch: 8, max_amount_cents: 40_000 },
      },
    );

    expect(merged).toEqual({
      hard_limits: { max_batch: 15, max_amount_cents: 100_000 },
      risk_escalation: { max_batch: 8, max_amount_cents: 40_000 },
    });
  });
});
