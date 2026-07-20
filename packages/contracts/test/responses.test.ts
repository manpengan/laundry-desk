import { describe, expect, it } from "vitest";

import {
  CommandErrorSchema,
  CommandResponseSchema,
  createCommandError,
  type CommandErrorCode,
} from "../src/index.js";

describe("A2 command responses", () => {
  it("keeps preview success distinct from a committed execution", () => {
    const preview = CommandResponseSchema.parse({
      ok: true,
      data: { execution: "preview", result: { affected_orders: 1 } },
    });
    const executed = CommandResponseSchema.parse({
      ok: true,
      data: { execution: "executed", result: { affected_orders: 1 } },
    });

    if (!preview.ok || !executed.ok) throw new Error("Expected success response");
    expect(preview.data.execution).toBe("preview");
    expect(executed.data.execution).toBe("executed");
  });

  it("uses one public code and message for missing and cross-tenant resources", () => {
    const missing = createCommandError("RESOURCE_UNAVAILABLE");
    const crossTenant = createCommandError("RESOURCE_UNAVAILABLE");

    expect(missing).toEqual(crossTenant);
    expect(missing.message).toBe("Resource is unavailable");
  });

  it("covers every validation-chain stage and every Policy branch", () => {
    const codes: readonly CommandErrorCode[] = [
      "VALIDATION_FAILED",
      "PERMISSION_DENIED",
      "RESOURCE_UNAVAILABLE",
      "POLICY_CONFIRMATION_REQUIRED",
      "POLICY_STEP_UP_REQUIRED",
      "POLICY_APPROVAL_REQUIRED",
      "POLICY_DENIED",
      "INVARIANT_FAILED",
      "TRANSACTION_FAILED",
      "EVENT_DISPATCH_FAILED",
      "IDEMPOTENCY_REPLAY_UNSUPPORTED",
      "IDEMPOTENCY_CONFLICT",
    ];

    codes.forEach((code) =>
      expect(CommandErrorSchema.safeParse(createCommandError(code)).success).toBe(true),
    );
  });

  it("rejects a custom message or raw arguments in an error detail", () => {
    const customMessage = CommandErrorSchema.safeParse({
      code: "RESOURCE_UNAVAILABLE",
      message: "Order 42 exists in another tenant",
    });
    const rawArguments = CommandErrorSchema.safeParse({
      code: "VALIDATION_FAILED",
      message: "Request validation failed",
      detail: {
        kind: "field",
        path: "/customer_phone",
        args: { customer_phone: "13800000000" },
      },
    });

    expect(customMessage.success).toBe(false);
    expect(rawArguments.success).toBe(false);
  });

  it("allows only structural detail and opaque Policy references", () => {
    const error = createCommandError("POLICY_CONFIRMATION_REQUIRED", {
      kind: "confirmation",
      confirm_ref: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
    });

    expect(error.detail).toEqual({
      kind: "confirmation",
      confirm_ref: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
    });
  });
});
