import { describe, expect, it } from "vitest";

import { issueBrowserSessionSource } from "../src/auth/browser-ingress.js";
import { issueEdgeReplaySource } from "../src/auth/edge-ingress.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  isAuthenticatedExecutionSource,
  isBrowserSessionSource,
  isEdgeReplaySource,
  parseAccessTokenClaims,
  parseEdgeQueueEnvelope,
} from "../src/index.js";

const ids = {
  session: "1131e8c3-b7e3-4633-8af8-a5e3286570e1",
  deviceSession: "cdfb3915-ab5e-48a4-a21d-ab7ff3d75b3a",
  org: "692e7b46-2c52-4b77-b790-c2cb4037b9ef",
  store: "74b83b3d-a9db-4d82-ba36-bb25a685cd3f",
  staff: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
  device: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  queue: "32ff7821-0b72-4f9c-8ec6-8d7e08500e04",
  grant: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
  lease: "e87a5f8a-e4d3-4404-b9c2-40cdf899e8d1",
} as const;

const accessClaims = {
  session_id: ids.session,
  session_version: 4,
  org_id: ids.org,
  store_id: ids.store,
  staff_id: ids.staff,
  device_id: ids.device,
  permission_version: 9,
  authentication_method: "password" as const,
  iat: 1_800_000_000,
  exp: 1_800_000_900,
};

const activeSession = {
  status: "active" as const,
  session_id: ids.session,
  session_version: 4,
  org_id: ids.org,
  store_id: ids.store,
  staff_id: ids.staff,
  device_id: ids.device,
  permission_version: 9,
  authentication_method: "password" as const,
};

const wirePayload = {
  command: "orders.collect_offline",
  version: "1.0.0",
  mode: "direct" as const,
  args: { order_id: "936da01f-9abd-4d9d-80c7-02af85c822a8" },
  idempotency_key: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
  dry_run: false,
};

const queueEnvelope = (authorization: Readonly<Record<string, unknown>>) =>
  parseEdgeQueueEnvelope({
    queue_envelope_version: 2,
    contracts_major: 0,
    queue_id: ids.queue,
    enqueued_at: "2026-07-21T01:02:03.000Z",
    payload: wirePayload,
    authorization,
  });

const grantQueueEnvelope = () =>
  queueEnvelope({
    kind: "grant",
    grant_id: ids.grant,
  });

const primaryLeaseQueueEnvelope = () =>
  queueEnvelope({
    kind: "primary_lease",
    grant_id: ids.grant,
    lease_id: ids.lease,
    primary_epoch: 7,
    per_lease_seq: 12,
  });

const browserInput = (via: "ui" | "ai" | "automation" = "ui") => ({
  via,
  claims: { ...accessClaims },
  session_record: { ...activeSession },
});

const edgeInput = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  device_session_id: ids.deviceSession,
  org_id: ids.org,
  store_id: ids.store,
  staff_id: ids.staff,
  device_id: ids.device,
  permission_version: 9,
  queue_envelope: grantQueueEnvelope(),
  verified_authorization: {
    kind: "grant" as const,
    grant_id: ids.grant,
    allowed_commands: [wirePayload.command],
    primary_lease_commands: [],
  },
  ...overrides,
});

const unstableProxy = <T extends object>(input: T, unstableKey: keyof T): T => {
  let descriptorReads = 0;
  return new Proxy(input, {
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property !== unstableKey || descriptor === undefined || !("value" in descriptor)) {
        return descriptor;
      }
      descriptorReads += 1;
      return descriptorReads === 1
        ? descriptor
        : { ...descriptor, value: `${String(descriptor.value)}-changed` };
    },
  });
};

describe("A5 access claims and active session binding", () => {
  it("freezes exact 900-second access claims", () => {
    const claims = parseAccessTokenClaims(accessClaims);

    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(claims).toEqual(accessClaims);
    expect(Object.isFrozen(claims)).toBe(true);
    expect(() => parseAccessTokenClaims({ ...accessClaims, exp: accessClaims.exp + 1 })).toThrow(
      /900/u,
    );
  });

  it.each([
    [{ ...accessClaims, extra: true }, "extra"],
    [
      Object.fromEntries(Object.entries(accessClaims).filter(([key]) => key !== "device_id")),
      "missing",
    ],
    [{ ...accessClaims, iat: new Number(accessClaims.iat) }, "boxed"],
    [Object.assign(Object.create({ inherited: true }), accessClaims), "non-plain"],
  ])("rejects malformed strict claims: %s", (input) => {
    expect(() => parseAccessTokenClaims(input)).toThrow();
  });

  it("rejects accessors without executing them", () => {
    let reads = 0;
    const input = { ...accessClaims } as Record<string, unknown>;
    Object.defineProperty(input, "session_id", {
      enumerable: true,
      get: () => {
        reads += 1;
        return ids.session;
      },
    });

    expect(() => parseAccessTokenClaims(input)).toThrow(/data property/u);
    expect(reads).toBe(0);
  });

  it("fails closed on unstable Proxy descriptors", () => {
    expect(() => parseAccessTokenClaims(unstableProxy({ ...accessClaims }, "session_id"))).toThrow(
      /stable/u,
    );
  });

  it.each(["ui", "ai", "automation"] as const)(
    "issues a deeply immutable %s browser source only for a matching active session",
    (via) => {
      const input = browserInput(via);
      const source = issueBrowserSessionSource(input);

      (input.claims as { staff_id: string }).staff_id = "4c0c60e4-59df-4d8b-95f1-2ffebc143ecd";
      (input.session_record as { store_id: string }).store_id =
        "2e08574b-f7a7-4bf6-a180-5396ebc59aea";

      expect(source).toEqual({
        kind: "browser_session",
        session_id: ids.session,
        session_version: 4,
        permission_version: 9,
        authentication_method: "password",
        actor: { staff_id: ids.staff, device_id: ids.device, via },
        tenant: { org_id: ids.org, store_id: ids.store },
      });
      expect(Object.isFrozen(source)).toBe(true);
      expect(Object.isFrozen(source.actor)).toBe(true);
      expect(Object.isFrozen(source.tenant)).toBe(true);
      expect(isBrowserSessionSource(source)).toBe(true);
      expect(isAuthenticatedExecutionSource(source)).toBe(true);
    },
  );

  it.each([
    [{ ...activeSession, status: "revoked" }, "revoked"],
    [null, "missing"],
    [{ ...activeSession, session_version: activeSession.session_version + 1 }, "version"],
    [{ ...activeSession, org_id: "4c0c60e4-59df-4d8b-95f1-2ffebc143ecd" }, "org"],
    [{ ...activeSession, store_id: "4c0c60e4-59df-4d8b-95f1-2ffebc143ecd" }, "store"],
    [{ ...activeSession, staff_id: "4c0c60e4-59df-4d8b-95f1-2ffebc143ecd" }, "staff"],
    [{ ...activeSession, device_id: "4c0c60e4-59df-4d8b-95f1-2ffebc143ecd" }, "device"],
    [{ ...activeSession, permission_version: activeSession.permission_version + 1 }, "permission"],
    [{ ...activeSession, authentication_method: "pin" }, "authentication method"],
  ])("fails closed for a %s session record", (sessionRecord, caseName) => {
    expect(
      () =>
        issueBrowserSessionSource({
          ...browserInput(),
          session_record: sessionRecord,
        }),
      caseName,
    ).toThrow();
  });

  it("rejects browser authority accessors, extra/missing keys, class inputs and invalid via", () => {
    let reads = 0;
    const accessor = {
      via: "ui",
      claims: accessClaims,
    } as Record<string, unknown>;
    Object.defineProperty(accessor, "session_record", {
      enumerable: true,
      get: () => {
        reads += 1;
        return activeSession;
      },
    });

    expect(() => issueBrowserSessionSource(accessor)).toThrow(/data property/u);
    expect(reads).toBe(0);
    expect(() => issueBrowserSessionSource({ ...browserInput(), extra: true })).toThrow();
    expect(() => issueBrowserSessionSource({ via: "ui", claims: accessClaims })).toThrow();
    expect(() =>
      issueBrowserSessionSource(Object.assign(new (class {})(), browserInput())),
    ).toThrow(/plain/u);
    expect(() => issueBrowserSessionSource({ ...browserInput(), via: "edge_replay" })).toThrow();
    expect(() => issueBrowserSessionSource(unstableProxy(browserInput(), "via"))).toThrow(
      /stable/u,
    );
  });

  it("does not accept plain, spread or JSON browser source forgeries", () => {
    const source = issueBrowserSessionSource(browserInput());
    const plain = {
      kind: "browser_session",
      session_id: ids.session,
      session_version: 4,
      permission_version: 9,
      authentication_method: "password",
      actor: { staff_id: ids.staff, device_id: ids.device, via: "ui" },
      tenant: { org_id: ids.org, store_id: ids.store },
    };

    expect(isBrowserSessionSource(plain)).toBe(false);
    expect(isBrowserSessionSource({ ...source })).toBe(false);
    expect(isBrowserSessionSource(JSON.parse(JSON.stringify(source)))).toBe(false);
    expect(isAuthenticatedExecutionSource(plain)).toBe(false);
  });
});

describe("A5 verified Edge replay source", () => {
  it("binds a grant source to device context, queue envelope and verified authorization", () => {
    const source = issueEdgeReplaySource(edgeInput());

    expect(source.kind).toBe("edge_replay");
    expect(source.actor).toEqual({
      staff_id: ids.staff,
      device_id: ids.device,
      via: "edge_replay",
    });
    expect(source.tenant).toEqual({ org_id: ids.org, store_id: ids.store });
    expect(source.queue_envelope.authorization).toEqual({ kind: "grant", grant_id: ids.grant });
    expect(source.verified_authorization).toEqual({
      kind: "grant",
      grant_id: ids.grant,
      allowed_commands: [wirePayload.command],
      primary_lease_commands: [],
    });
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.queue_envelope)).toBe(true);
    expect(Object.isFrozen(source.verified_authorization.allowed_commands)).toBe(true);
    expect(isEdgeReplaySource(source)).toBe(true);
    expect(isAuthenticatedExecutionSource(source)).toBe(true);
  });

  it("binds every lease identifier and epoch in the verified authorization", () => {
    const source = issueEdgeReplaySource(
      edgeInput({
        queue_envelope: primaryLeaseQueueEnvelope(),
        verified_authorization: {
          kind: "primary_lease",
          grant_id: ids.grant,
          lease_id: ids.lease,
          primary_epoch: 7,
          allowed_commands: [wirePayload.command],
          primary_lease_commands: [wirePayload.command],
        },
      }),
    );

    expect(source.verified_authorization.kind).toBe("primary_lease");
    expect(source.queue_envelope.authorization.kind).toBe("primary_lease");
  });

  it.each([
    [
      {
        verified_authorization: {
          kind: "grant",
          grant_id: "4c0c60e4-59df-4d8b-95f1-2ffebc143ecd",
          allowed_commands: [wirePayload.command],
          primary_lease_commands: [],
        },
      },
      "grant mismatch",
    ],
    [
      {
        queue_envelope: primaryLeaseQueueEnvelope(),
        verified_authorization: {
          kind: "primary_lease",
          grant_id: ids.grant,
          lease_id: "4c0c60e4-59df-4d8b-95f1-2ffebc143ecd",
          primary_epoch: 7,
          allowed_commands: [wirePayload.command],
          primary_lease_commands: [wirePayload.command],
        },
      },
      "lease mismatch",
    ],
    [
      {
        queue_envelope: primaryLeaseQueueEnvelope(),
        verified_authorization: {
          kind: "primary_lease",
          grant_id: ids.grant,
          lease_id: ids.lease,
          primary_epoch: 8,
          allowed_commands: [wirePayload.command],
          primary_lease_commands: [wirePayload.command],
        },
      },
      "epoch mismatch",
    ],
    [
      {
        verified_authorization: {
          kind: "grant",
          grant_id: ids.grant,
          allowed_commands: ["orders.create_offline"],
          primary_lease_commands: [],
        },
      },
      "command not allowed",
    ],
    [
      {
        verified_authorization: {
          kind: "grant",
          grant_id: ids.grant,
          allowed_commands: [wirePayload.command],
          primary_lease_commands: [wirePayload.command],
        },
      },
      "lease-required command on grant",
    ],
  ])("rejects Edge authorization inconsistency: %s", (overrides, caseName) => {
    expect(() => issueEdgeReplaySource(edgeInput(overrides)), caseName).toThrow();
  });

  it("rejects Edge accessors without executing them and fails closed on malformed inputs", () => {
    let reads = 0;
    const accessor = { ...edgeInput() } as Record<string, unknown>;
    Object.defineProperty(accessor, "device_session_id", {
      enumerable: true,
      get: () => {
        reads += 1;
        return ids.deviceSession;
      },
    });

    expect(() => issueEdgeReplaySource(accessor)).toThrow(/data property/u);
    expect(reads).toBe(0);
    expect(() => issueEdgeReplaySource({ ...edgeInput(), extra: true })).toThrow();
    expect(() => {
      const missing = Object.fromEntries(
        Object.entries(edgeInput()).filter(([key]) => key !== "device_session_id"),
      );
      issueEdgeReplaySource(missing);
    }).toThrow();
    expect(() => issueEdgeReplaySource(Object.assign(new (class {})(), edgeInput()))).toThrow(
      /plain/u,
    );
    expect(() => issueEdgeReplaySource(unstableProxy(edgeInput(), "device_session_id"))).toThrow(
      /stable/u,
    );
  });

  it("rejects plain, spread and JSON Edge source forgeries", () => {
    const source = issueEdgeReplaySource(edgeInput());

    expect(isEdgeReplaySource({ ...source })).toBe(false);
    expect(isEdgeReplaySource(JSON.parse(JSON.stringify(source)))).toBe(false);
    expect(
      isEdgeReplaySource({
        kind: "edge_replay",
        actor: source.actor,
        tenant: source.tenant,
        queue_envelope: source.queue_envelope,
        verified_authorization: source.verified_authorization,
      }),
    ).toBe(false);
  });
});
