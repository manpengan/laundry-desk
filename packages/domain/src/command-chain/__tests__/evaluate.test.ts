import { describe, it, expect, vi } from "vitest";

import { evaluateCommandChain } from "../evaluate.js";
import {
  COMMAND_CHAIN_STEPS,
  type CommandChainContext,
  type CommandChainPorts,
  type CommandChainStep,
  type StepResult,
} from "../types.js";

type TestMeta = Readonly<{ actorId: string; orgId: string }>;
type TestInput = Readonly<{ amount_cents: number; note?: string }>;
type TestParsed = Readonly<{ amount_cents: number; note: string }>;
type TestError = Readonly<{ code: string; message: string }>;
type TestPolicy = Readonly<{ risk: "R0" | "R3" }>;
type TestInvariants = Readonly<{ preview: boolean }>;

type TestPorts = CommandChainPorts<
  TestMeta,
  TestInput,
  TestParsed,
  TestError,
  TestPolicy,
  TestInvariants
>;

const ok = <T>(data: T): StepResult<T, TestError> => ({ ok: true, data });
const fail = (code: string, message: string): StepResult<never, TestError> => ({
  ok: false,
  error: { code, message },
});

const baseContext = (): CommandChainContext<TestMeta, TestInput> =>
  Object.freeze({
    meta: Object.freeze({ actorId: "staff_01", orgId: "org_01" }),
    input: Object.freeze({ amount_cents: 2900, note: "rush" }),
  });

type InstrumentedPorts = TestPorts & { readonly calls: string[] };

const createPassingPorts = (overrides: Partial<TestPorts> = {}): InstrumentedPorts => {
  const calls: string[] = [];
  const defaults: TestPorts = {
    parseInput: (input) => {
      calls.push("parseInput");
      return ok({ amount_cents: input.amount_cents, note: input.note ?? "" });
    },
    checkRbac: () => {
      calls.push("rbac");
      return ok(undefined);
    },
    checkTenant: () => {
      calls.push("tenant");
      return ok(undefined);
    },
    checkPolicy: () => {
      calls.push("policy");
      return ok({ risk: "R0" });
    },
    checkInvariants: () => {
      calls.push("invariants");
      return ok({ preview: true });
    },
  };
  return { calls, ...defaults, ...overrides };
};

/** Build ports that fail at `failAt` and record which steps actually ran. */
const createFailAtPorts = (failAt: CommandChainStep): { ports: TestPorts; calls: string[] } => {
  const calls: string[] = [];
  const record = (step: CommandChainStep): void => {
    calls.push(step);
  };

  const ports: TestPorts = {
    parseInput: (input) => {
      record("parseInput");
      if (failAt === "parseInput") {
        return fail("VALIDATION_FAILED", "bad input");
      }
      return ok({ amount_cents: input.amount_cents, note: input.note ?? "" });
    },
    checkRbac: () => {
      record("rbac");
      if (failAt === "rbac") {
        return fail("PERMISSION_DENIED", "no permission");
      }
      return ok(undefined);
    },
    checkTenant: () => {
      record("tenant");
      if (failAt === "tenant") {
        return fail("PERMISSION_DENIED", "cross-tenant");
      }
      return ok(undefined);
    },
    checkPolicy: () => {
      record("policy");
      if (failAt === "policy") {
        return fail("POLICY_DENIED", "denied by policy");
      }
      return ok({ risk: "R0" });
    },
    checkInvariants: () => {
      record("invariants");
      if (failAt === "invariants") {
        return fail("INVARIANT_FAILED", "invariant broken");
      }
      return ok({ preview: true });
    },
  };

  return { ports, calls };
};

const expectedCallsThrough = (failAt: CommandChainStep): string[] => {
  const index = COMMAND_CHAIN_STEPS.indexOf(failAt);
  return COMMAND_CHAIN_STEPS.slice(0, index + 1).map(String);
};

describe("B2 command validation chain (fixed order, fail-closed)", () => {
  it("exposes the fixed step order Zod → RBAC → tenant → Policy → invariant", () => {
    expect(COMMAND_CHAIN_STEPS).toEqual(["parseInput", "rbac", "tenant", "policy", "invariants"]);
  });

  it("runs all five ports in order and returns frozen success data", async () => {
    const context = baseContext();
    const ports = createPassingPorts();

    const result = await evaluateCommandChain(context, ports);

    expect(ports.calls).toEqual(["parseInput", "rbac", "tenant", "policy", "invariants"]);
    expect(result).toEqual({
      ok: true,
      data: {
        parsed: { amount_cents: 2900, note: "rush" },
        policy: { risk: "R0" },
        invariants: { preview: true },
      },
    });
    if (!result.ok) {
      throw new Error("expected success");
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.data)).toBe(true);
  });

  it.each([...COMMAND_CHAIN_STEPS])(
    "stops at first failure on %s and does not call later steps",
    async (step) => {
      const { ports, calls } = createFailAtPorts(step);

      const result = await evaluateCommandChain(baseContext(), ports);

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected failure");
      }
      expect(result.step).toBe(step);
      expect(result.error).toEqual(
        expect.objectContaining({ code: expect.any(String), message: expect.any(String) }),
      );
      expect(calls).toEqual(expectedCallsThrough(step));
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it("does not mutate the input context object", async () => {
    const input: { amount_cents: number; note?: string } = {
      amount_cents: 100,
      note: "x",
    };
    const meta: { actorId: string; orgId: string } = {
      actorId: "staff_02",
      orgId: "org_02",
    };
    const context: CommandChainContext<typeof meta, typeof input> = { meta, input };
    const snapshot = structuredClone(context);

    await evaluateCommandChain(context, createPassingPorts());

    expect(context).toEqual(snapshot);
    expect(input).toEqual(snapshot.input);
    expect(meta).toEqual(snapshot.meta);

    const frozenContext = Object.freeze({
      meta: Object.freeze({ actorId: "staff_03", orgId: "org_03" }),
      input: Object.freeze({ amount_cents: 200 as number, note: "frozen" }),
    });
    await expect(evaluateCommandChain(frozenContext, createPassingPorts())).resolves.toMatchObject({
      ok: true,
    });
  });

  it("propagates thrown errors from ports without silent catch", async () => {
    const ports = createPassingPorts({
      checkTenant: () => {
        throw new Error("db unavailable");
      },
    });

    await expect(evaluateCommandChain(baseContext(), ports)).rejects.toThrow("db unavailable");
    expect(ports.calls).toEqual(["parseInput", "rbac"]);
  });

  it("supports async ports (Promise-returning IO callbacks)", async () => {
    const ports = createPassingPorts({
      parseInput: async (input) => {
        await Promise.resolve();
        return ok({ amount_cents: input.amount_cents, note: "async" });
      },
      checkPolicy: async () => {
        await Promise.resolve();
        return ok({ risk: "R3" });
      },
    });

    const result = await evaluateCommandChain(baseContext(), ports);
    expect(result).toEqual({
      ok: true,
      data: {
        parsed: { amount_cents: 2900, note: "async" },
        policy: { risk: "R3" },
        invariants: { preview: true },
      },
    });
  });

  it("passes parsed input and policy data into later ports", async () => {
    const checkRbac = vi.fn(() => ok(undefined));
    const checkTenant = vi.fn(() => ok(undefined));
    const checkPolicy = vi.fn(() => ok({ risk: "R3" as const }));
    const checkInvariants = vi.fn(() => ok({ preview: false }));

    const context = baseContext();
    const ports = createPassingPorts({
      parseInput: () => ok({ amount_cents: 500, note: "parsed-note" }),
      checkRbac,
      checkTenant,
      checkPolicy,
      checkInvariants,
    });

    await evaluateCommandChain(context, ports);

    expect(checkRbac).toHaveBeenCalledWith({ amount_cents: 500, note: "parsed-note" }, context);
    expect(checkTenant).toHaveBeenCalledWith({ amount_cents: 500, note: "parsed-note" }, context);
    expect(checkPolicy).toHaveBeenCalledWith({ amount_cents: 500, note: "parsed-note" }, context);
    expect(checkInvariants).toHaveBeenCalledWith(
      { amount_cents: 500, note: "parsed-note" },
      context,
      { risk: "R3" },
    );
  });

  it("returns distinct step tags so host can map to public error codes", async () => {
    const ports = createPassingPorts({
      checkRbac: () => fail("PERMISSION_DENIED", "rbac"),
    });
    const result = await evaluateCommandChain(baseContext(), ports);
    expect(result).toEqual({
      ok: false,
      step: "rbac",
      error: { code: "PERMISSION_DENIED", message: "rbac" },
    });
  });
});
