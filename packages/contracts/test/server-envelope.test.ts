import { describe, expect, it } from "vitest";

import {
  CommandWirePayloadSchema,
  CommandViaSchema,
  injectAuthenticatedCommandContext,
  isServerCommandEnvelope,
} from "../src/index.js";

const wirePayload = CommandWirePayloadSchema.parse({
  command: "orders.cancel",
  version: "1.0.0",
  mode: "direct",
  args: { order_id: "bd042a25-1d95-4b5d-a3f6-7a62b451ae39" },
  idempotency_key: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
  dry_run: false,
});

const trustedContext = {
  actor: {
    staff_id: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
    device_id: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    via: "ui" as const,
  },
  tenant: {
    org_id: "692e7b46-2c52-4b77-b790-c2cb4037b9ef",
    store_id: "74b83b3d-a9db-4d82-ba36-bb25a685cd3f",
  },
};

describe("A2 authenticated server command envelope", () => {
  it("injects trusted actor and tenant context into a registered envelope", () => {
    const envelope = injectAuthenticatedCommandContext(wirePayload, trustedContext);

    expect(envelope.actor).toEqual(trustedContext.actor);
    expect(envelope.tenant).toEqual(trustedContext.tenant);
    expect(isServerCommandEnvelope(envelope)).toBe(true);
  });

  it("rejects a spread or JSON-round-tripped structural forgery", () => {
    const envelope = injectAuthenticatedCommandContext(wirePayload, trustedContext);
    const spreadForgery = { ...envelope };
    const jsonForgery = JSON.parse(JSON.stringify(envelope)) as unknown;

    expect(isServerCommandEnvelope(spreadForgery)).toBe(false);
    expect(isServerCommandEnvelope(jsonForgery)).toBe(false);
  });

  it("accepts every audited actor source and no extra source", () => {
    const accepted = ["ui", "ai", "automation", "edge_replay"];

    accepted.forEach((via) => expect(CommandViaSchema.safeParse(via).success).toBe(true));
    expect(CommandViaSchema.safeParse("browser").success).toBe(false);
  });

  it("refuses malformed authenticated context before creating an envelope", () => {
    expect(() =>
      injectAuthenticatedCommandContext(wirePayload, {
        ...trustedContext,
        tenant: { ...trustedContext.tenant, org_id: "not-a-uuid" },
      }),
    ).toThrow();
  });

  it("re-parses the wire boundary so injected context cannot arrive from a caller", () => {
    expect(() =>
      injectAuthenticatedCommandContext(
        { ...wirePayload, tenant: trustedContext.tenant },
        trustedContext,
      ),
    ).toThrow();
  });
});
