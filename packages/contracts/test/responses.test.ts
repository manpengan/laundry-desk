import { describe, expect, it } from "vitest";

import { AUTH_PUBLIC_ERROR_DESCRIPTORS } from "../src/envelope/responses.js";
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
      "AUTHENTICATION_FAILED",
      "CSRF_REJECTED",
      "RATE_LIMITED",
    ];

    codes.forEach((code) =>
      expect(CommandErrorSchema.safeParse(createCommandError(code)).success).toBe(true),
    );
  });

  it("freezes the exact auth public error messages and HTTP statuses", () => {
    expect(AUTH_PUBLIC_ERROR_DESCRIPTORS).toEqual({
      AUTHENTICATION_FAILED: {
        code: "AUTHENTICATION_FAILED",
        message: "Authentication failed",
        http_status: 401,
      },
      CSRF_REJECTED: {
        code: "CSRF_REJECTED",
        message: "Request origin verification failed",
        http_status: 403,
      },
      RATE_LIMITED: {
        code: "RATE_LIMITED",
        message: "Too many requests",
        http_status: 429,
      },
    });
    expect(Object.isFrozen(AUTH_PUBLIC_ERROR_DESCRIPTORS)).toBe(true);
    Object.values(AUTH_PUBLIC_ERROR_DESCRIPTORS).forEach((descriptor) =>
      expect(Object.isFrozen(descriptor)).toBe(true),
    );
  });

  it("does not reveal unknown, revoked or reused refresh-token state", () => {
    const outputs = (["unknown", "revoked", "reused"] as const).map(() =>
      createCommandError("AUTHENTICATION_FAILED"),
    );

    expect(new Set(outputs.map((output) => JSON.stringify(output)))).toEqual(
      new Set(['{"code":"AUTHENTICATION_FAILED","message":"Authentication failed"}']),
    );
    expect(outputs[0]).not.toHaveProperty("http_status");
  });

  it.each(["AUTHENTICATION_FAILED", "CSRF_REJECTED", "RATE_LIMITED"] as const)(
    "forbids detail on fixed auth error %s",
    (code) => {
      expect(() =>
        Reflect.apply(createCommandError, undefined, [
          code,
          { kind: "reason", reason: "unavailable" },
        ]),
      ).toThrow();
      expect(
        CommandErrorSchema.safeParse({
          ...createCommandError(code),
          detail: { kind: "reason", reason: "unavailable" },
        }).success,
      ).toBe(false);
    },
  );

  it("deep-freezes generated fixed and detailed errors", () => {
    const fixed = createCommandError("AUTHENTICATION_FAILED");
    const detailed = createCommandError("VALIDATION_FAILED", {
      kind: "field",
      path: "/username",
    });

    expect(Object.isFrozen(fixed)).toBe(true);
    expect(Object.isFrozen(detailed)).toBe(true);
    expect(Object.isFrozen(detailed.detail)).toBe(true);
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
