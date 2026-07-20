import { describe, expect, it } from "vitest";

import { CommandWirePayloadSchema, IdempotencyKeySchema } from "../src/index.js";

const requestKey = "9dfc4424-9b9a-4e52-baaa-c02868f8e7de";

describe("A2 command wire payload", () => {
  it("accepts a direct payload with JSON arguments", () => {
    const parsed = CommandWirePayloadSchema.parse({
      command: "orders.cancel",
      version: "1.0.0",
      mode: "direct",
      args: { order_id: "bd042a25-1d95-4b5d-a3f6-7a62b451ae39", reason: "customer_request" },
      idempotency_key: requestKey,
      dry_run: true,
    });

    expect(parsed).toMatchObject({ mode: "direct", dry_run: true });
  });

  it("accepts a confirm payload without caller-supplied arguments", () => {
    const parsed = CommandWirePayloadSchema.parse({
      command: "orders.cancel",
      version: "1.0.0",
      mode: "confirm",
      confirm_ref: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
      idempotency_key: requestKey,
      dry_run: false,
    });

    expect(parsed).toMatchObject({ mode: "confirm", dry_run: false });
  });

  it("rejects a payload that combines frozen confirmation and new arguments", () => {
    const result = CommandWirePayloadSchema.safeParse({
      command: "orders.cancel",
      version: "1.0.0",
      mode: "confirm",
      confirm_ref: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
      args: { order_id: "bd042a25-1d95-4b5d-a3f6-7a62b451ae39" },
      idempotency_key: requestKey,
      dry_run: false,
    });

    expect(result.success).toBe(false);
  });

  it("rejects self-reported actor or tenant context on the wire", () => {
    const actorResult = CommandWirePayloadSchema.safeParse({
      command: "orders.cancel",
      version: "1.0.0",
      mode: "direct",
      args: {},
      idempotency_key: requestKey,
      dry_run: false,
      actor: { staff_id: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c" },
    });
    const tenantResult = CommandWirePayloadSchema.safeParse({
      command: "orders.cancel",
      version: "1.0.0",
      mode: "direct",
      args: {},
      idempotency_key: requestKey,
      dry_run: false,
      tenant: { org_id: "692e7b46-2c52-4b77-b790-c2cb4037b9ef" },
    });

    expect(actorResult.success).toBe(false);
    expect(tenantResult.success).toBe(false);
  });

  it("requires a caller-generated UUID idempotency key", () => {
    expect(IdempotencyKeySchema.safeParse("not-a-uuid").success).toBe(false);
    expect(IdempotencyKeySchema.safeParse(requestKey).success).toBe(true);
  });

  it("rejects executable or non-JSON direct arguments", () => {
    const result = CommandWirePayloadSchema.safeParse({
      command: "orders.cancel",
      version: "1.0.0",
      mode: "direct",
      args: { requested_at: new Date() },
      idempotency_key: requestKey,
      dry_run: false,
    });

    expect(result.success).toBe(false);
  });

  it("rejects prototype-related direct argument keys", () => {
    const unsafeArguments = [
      JSON.parse('{"__proto__":{"is_admin":true}}'),
      JSON.parse('{"order":{"constructor":{"is_admin":true}}}'),
      JSON.parse('{"order":{"actor":{"prototype":{"is_admin":true}}}}'),
    ];
    const results = unsafeArguments.map((args) =>
      CommandWirePayloadSchema.safeParse({
        command: "orders.cancel",
        version: "1.0.0",
        mode: "direct",
        args,
        idempotency_key: requestKey,
        dry_run: false,
      }),
    );

    expect(results.every((result) => !result.success)).toBe(true);
  });
});
