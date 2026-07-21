import { describe, expect, it } from "vitest";

import { issueBrowserSessionSource } from "../src/auth/browser-ingress.js";
import { issueEdgeReplaySource } from "../src/auth/edge-ingress.js";
import {
  CommandWirePayloadSchema,
  CommandViaSchema,
  injectAuthenticatedCommandContext,
  isServerCommandEnvelope,
  parseEdgeQueueEnvelope,
} from "../src/index.js";

const wirePayload = CommandWirePayloadSchema.parse({
  command: "orders.cancel",
  version: "1.0.0",
  mode: "direct",
  args: { order_id: "bd042a25-1d95-4b5d-a3f6-7a62b451ae39" },
  idempotency_key: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
  dry_run: false,
});

const claims = {
  session_id: "1131e8c3-b7e3-4633-8af8-a5e3286570e1",
  session_version: 4,
  org_id: "692e7b46-2c52-4b77-b790-c2cb4037b9ef",
  store_id: "74b83b3d-a9db-4d82-ba36-bb25a685cd3f",
  staff_id: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
  device_id: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  permission_version: 9,
  authentication_method: "password" as const,
  iat: 1_800_000_000,
  exp: 1_800_000_900,
};

const browserSource = (via: "ui" | "ai" | "automation" = "ui") =>
  issueBrowserSessionSource({
    via,
    claims,
    session_record: {
      status: "active",
      session_id: claims.session_id,
      session_version: claims.session_version,
      org_id: claims.org_id,
      store_id: claims.store_id,
      staff_id: claims.staff_id,
      device_id: claims.device_id,
      permission_version: claims.permission_version,
      authentication_method: claims.authentication_method,
    },
  });

const edgeSource = () => {
  const queueEnvelope = parseEdgeQueueEnvelope({
    queue_envelope_version: 2,
    contracts_major: 0,
    queue_id: "32ff7821-0b72-4f9c-8ec6-8d7e08500e04",
    enqueued_at: "2026-07-21T01:02:03.000Z",
    payload: wirePayload,
    authorization: {
      kind: "grant",
      grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
    },
  });

  return issueEdgeReplaySource({
    device_session_id: "cdfb3915-ab5e-48a4-a21d-ab7ff3d75b3a",
    org_id: "692e7b46-2c52-4b77-b790-c2cb4037b9ef",
    store_id: "74b83b3d-a9db-4d82-ba36-bb25a685cd3f",
    staff_id: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
    device_id: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    permission_version: 9,
    queue_envelope: queueEnvelope,
    authorization: {
      kind: "grant",
      grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
      allowed_commands: [wirePayload.command],
      primary_lease_commands: [],
    },
  });
};

describe("A2 authenticated server command envelope", () => {
  it("injects trusted actor and tenant context into a registered envelope", () => {
    const source = browserSource();
    const envelope = injectAuthenticatedCommandContext(wirePayload, source);

    expect(envelope.actor).toEqual(source.actor);
    expect(envelope.tenant).toEqual(source.tenant);
    expect(isServerCommandEnvelope(envelope)).toBe(true);
  });

  it("rejects a spread or JSON-round-tripped structural forgery", () => {
    const envelope = injectAuthenticatedCommandContext(wirePayload, browserSource());
    const spreadForgery = { ...envelope };
    const jsonForgery = JSON.parse(JSON.stringify(envelope)) as unknown;

    expect(isServerCommandEnvelope(spreadForgery)).toBe(false);
    expect(isServerCommandEnvelope(jsonForgery)).toBe(false);
  });

  it("accepts browser provenance only for browser via and Edge provenance only for replay", () => {
    const accepted = ["ui", "ai", "automation", "edge_replay"];

    accepted.forEach((via) => expect(CommandViaSchema.safeParse(via).success).toBe(true));
    expect(CommandViaSchema.safeParse("browser").success).toBe(false);
    ["ui", "ai", "automation"].forEach((via) => {
      const envelope = injectAuthenticatedCommandContext(
        wirePayload,
        browserSource(via as "ui" | "ai" | "automation"),
      );
      expect(envelope.actor.via).toBe(via);
    });
    expect(injectAuthenticatedCommandContext(wirePayload, edgeSource()).actor.via).toBe(
      "edge_replay",
    );
  });

  it("refuses caller-shaped context and source/via provenance forgeries", () => {
    const source = browserSource();
    expect(() =>
      injectAuthenticatedCommandContext(wirePayload, {
        actor: source.actor,
        tenant: source.tenant,
      } as never),
    ).toThrow();
    expect(() =>
      injectAuthenticatedCommandContext(wirePayload, {
        ...source,
        actor: { ...source.actor, via: "edge_replay" },
      } as never),
    ).toThrow();
  });

  it("re-parses the wire boundary so injected context cannot arrive from a caller", () => {
    expect(() =>
      injectAuthenticatedCommandContext(
        { ...wirePayload, tenant: browserSource().tenant },
        browserSource(),
      ),
    ).toThrow();
  });

  it("does not execute wire accessors", () => {
    let reads = 0;
    const accessorWire = { ...wirePayload } as Record<string, unknown>;
    Object.defineProperty(accessorWire, "command", {
      enumerable: true,
      get: () => {
        reads += 1;
        return wirePayload.command;
      },
    });

    expect(() => injectAuthenticatedCommandContext(accessorWire, browserSource())).toThrow(
      /data property/u,
    );
    expect(reads).toBe(0);
  });

  it("rejects an Edge source paired with a different queue payload", () => {
    expect(() =>
      injectAuthenticatedCommandContext(
        { ...wirePayload, command: "orders.create_offline" },
        edgeSource(),
      ),
    ).toThrow(/queue payload/u);
  });
});
