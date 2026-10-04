import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import type { AuthorizedSession } from "../auth/session-view.js";
import type { AssistanceTrust } from "./protocol.js";
import type { AssistanceGrant, AssistanceRepository, StoredAssistance } from "./repository.js";
export function proofFixture() {
  const keys = generateKeyPairSync("ed25519");
  const trust: AssistanceTrust = {
    version: 1,
    broker_url: "https://support.example/",
    broker_token: "b".repeat(32),
    issuer: "https://identity.example",
    audience: "laundry-support",
    kid: "fixture-key",
    public_key_spki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
  const now = 1791000000000;
  const claims = {
    iss: trust.issuer,
    aud: trust.audience,
    sub: "synthetic-operator",
    iat: now / 1000,
    exp: now / 1000 + 60,
    auth_time: now / 1000,
    amr: ["pwd", "otp", "mfa"],
    session_id: randomUUID(),
    nonce: randomBytes(32).toString("base64url"),
    jti: randomUUID(),
    command: "runtime.health",
  };
  const signed = (
    body: Record<string, unknown> = claims,
    header: Record<string, unknown> = { alg: "EdDSA", typ: "JWT", kid: trust.kid },
  ) => {
    const data = [header, body]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    return `${data}.${sign(null, Buffer.from(data), keys.privateKey).toString("base64url")}`;
  };
  return { trust, now, claims, signed };
}
export function actorFixture(): AuthorizedSession {
  const staffId = randomUUID();
  return {
    session: {
      session_id: randomUUID(),
      family_id: randomUUID(),
      org_id: randomUUID(),
      store_id: randomUUID(),
      staff_id: staffId,
      device_id: randomUUID(),
      session_version: 1,
      permission_version: 1,
      authentication_method: "password",
      status: "active",
      created_at: 1,
      revoked_at: null,
    },
    authority: {
      staff_id: staffId,
      display_name: "Fixture",
      role: "admin",
      permission_version: 1,
      is_privacy_admin: true,
    },
  };
}
export function repositoryFixture() {
  let stored: StoredAssistance | null = null;
  const calls: string[] = [];
  const requests = new Set<string>();
  const repository: AssistanceRepository = {
    approve: async (grant) => {
      stored = {
        id: grant.id,
        status: "active",
        expires_at: new Date(grant.expiresAt),
        commands_completed: 0,
      };
      calls.push("authorize");
    },
    status: async () => stored,
    verify: async (grant) => {
      if (stored?.id !== grant.id || stored.status !== "active") throw new Error("revoked");
      calls.push("verify");
    },
    terminate: async (_grant, status) => {
      if (stored?.status === "active") stored = { ...stored, status };
      calls.push(status);
    },
    revoke: async () => {
      if (stored) stored = { ...stored, status: "revoked" };
      calls.push("revoke");
    },
    execute: async (_grant, requestId, command) => {
      if (requests.has(requestId)) throw new Error("replay");
      requests.add(requestId);
      if (stored) stored = { ...stored, commands_completed: stored.commands_completed + 1 };
      calls.push(command);
      return { database: "ready", mode: "windows_local" };
    },
    delivered: async () => {
      calls.push("delivered");
    },
  };
  const seed = async (grant: AssistanceGrant) => repository.approve(grant);
  return { repository, calls, seed };
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
