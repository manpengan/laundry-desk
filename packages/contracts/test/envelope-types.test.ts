import { expectTypeOf, it } from "vitest";

import {
  CommandErrorSchema,
  CommandResponseSchema,
  CommandWirePayloadSchema,
  injectAuthenticatedCommandContext,
  type CommandError,
  type CommandResponse,
  type CommandWirePayload,
  type ServerCommandEnvelope,
} from "../src/index.js";

it("keeps wire payloads structurally distinct from trusted server envelopes", () => {
  const wirePayload = CommandWirePayloadSchema.parse({
    command: "orders.cancel",
    version: "1.0.0",
    mode: "confirm",
    confirm_ref: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
    idempotency_key: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
    dry_run: false,
  });

  expectTypeOf<CommandWirePayload>().not.toMatchTypeOf<ServerCommandEnvelope>();

  if (Math.random() < 0) {
    // @ts-expect-error Only the authenticated-context injection factory owns the private brand.
    const forged: ServerCommandEnvelope = wirePayload;
    expectTypeOf(forged).toMatchTypeOf<ServerCommandEnvelope>();
  }
});

it("prevents a trusted server envelope from being sent as a wire payload", () => {
  const envelope = injectAuthenticatedCommandContext(
    {
      command: "orders.cancel",
      version: "1.0.0",
      mode: "direct",
      args: {},
      idempotency_key: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
      dry_run: false,
    },
    {
      actor: {
        staff_id: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
        device_id: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
        via: "ui",
      },
      tenant: {
        org_id: "692e7b46-2c52-4b77-b790-c2cb4037b9ef",
        store_id: "74b83b3d-a9db-4d82-ba36-bb25a685cd3f",
      },
    },
  );

  if (Math.random() < 0) {
    // @ts-expect-error Server-only identity must never be serialized as a branded wire payload.
    const leakedWirePayload: CommandWirePayload = envelope;
    // @ts-expect-error Nested authenticated identity is immutable in the public type as at runtime.
    envelope.actor.via = "ai";
    // @ts-expect-error Tenant scope is immutable after C8 has injected it.
    envelope.tenant.store_id = "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c";
    expectTypeOf(leakedWirePayload).toMatchTypeOf<CommandWirePayload>();
  }
});

it("binds each public error code to its fixed public message at compile time", () => {
  if (Math.random() < 0) {
    const leak: CommandError = {
      code: "RESOURCE_UNAVAILABLE",
      // @ts-expect-error A caller cannot type a tenant-probing message for a fixed public error code.
      message: "Order 42 belongs to a different tenant",
    };
    expectTypeOf(leak).toMatchTypeOf<CommandError>();
  }
});

it("keeps public schema output assignable to every corresponding public type", () => {
  const wirePayload: CommandWirePayload = CommandWirePayloadSchema.parse({
    command: "orders.cancel",
    version: "1.0.0",
    mode: "direct",
    args: {},
    idempotency_key: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
    dry_run: false,
  });
  const error: CommandError = CommandErrorSchema.parse({
    code: "RESOURCE_UNAVAILABLE",
    message: "Resource is unavailable",
  });
  const response: CommandResponse = CommandResponseSchema.parse({
    ok: false,
    error,
  });

  expectTypeOf(wirePayload).toMatchTypeOf<CommandWirePayload>();
  expectTypeOf(error).toMatchTypeOf<CommandError>();
  expectTypeOf(response).toMatchTypeOf<CommandResponse>();
});
