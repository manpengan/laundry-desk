import { describe, expect, it } from "vitest";

import {
  REFRESH_COOKIE_CLEAR_DESCRIPTOR,
  REFRESH_COOKIE_DESCRIPTOR,
  REFRESH_TOKEN_TTL_SECONDS,
  RefreshFamilyRecordSchema,
  RefreshTokenRecordSchema,
  classifyLogoutHttpCredential,
  classifyLogoutStorageMutation,
  classifyRefreshCasCommit,
  planRefreshMutation,
  planRefreshRevocation,
  planSessionFamilyReplacement,
} from "../src/auth/refresh.js";

const ids = {
  token: "e5ed715a-4034-49d6-89cc-79f4539dbab4",
  replacementToken: "fdbd1a32-7ee3-4d28-a6ab-923b22c0fe99",
  family: "8aef4f00-d823-4e76-90f5-e03070905d92",
  session: "1131e8c3-b7e3-4633-8af8-a5e3286570e1",
  nextFamily: "66e54d2c-e99e-49f8-8f1d-d3d2f363394e",
  nextSession: "7bb79d86-dc5c-47de-9218-d503ed3c9efb",
} as const;

const activeToken = {
  status: "active" as const,
  token_id: ids.token,
  family_id: ids.family,
  session_id: ids.session,
  expires_at: 1_801_209_600,
};

const activeFamily = {
  status: "active" as const,
  family_id: ids.family,
  session_id: ids.session,
};

const activeSession = {
  status: "active" as const,
  session_id: ids.session,
  session_version: 4,
};

const mutationInput = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  token: { ...activeToken },
  family: { ...activeFamily },
  session: { ...activeSession },
  now_epoch_seconds: 1_800_000_000,
  replacement_token_id: ids.replacementToken,
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

const expectDeepFrozen = (value: unknown, seen = new WeakSet<object>()): void => {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach((entry) => expectDeepFrozen(entry, seen));
};

describe("A5 refresh cookie contract", () => {
  it("freezes the exact 14-day __Host refresh cookie attributes", () => {
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(1_209_600);
    expect(REFRESH_COOKIE_DESCRIPTOR).toEqual({
      name: "__Host-laundry_refresh",
      secure: true,
      http_only: true,
      same_site: "strict",
      path: "/",
      max_age_seconds: 1_209_600,
    });
    expect("domain" in REFRESH_COOKIE_DESCRIPTOR).toBe(false);
    expectDeepFrozen(REFRESH_COOKIE_DESCRIPTOR);
  });

  it("clears the refresh cookie with identical scope and Max-Age zero", () => {
    expect(REFRESH_COOKIE_CLEAR_DESCRIPTOR).toEqual({
      ...REFRESH_COOKIE_DESCRIPTOR,
      max_age_seconds: 0,
    });
    expect("domain" in REFRESH_COOKIE_CLEAR_DESCRIPTOR).toBe(false);
    expectDeepFrozen(REFRESH_COOKIE_CLEAR_DESCRIPTOR);
  });
});

describe("A5 refresh token and family records", () => {
  it("allows replacement_token_id only on the rotated token branch", () => {
    expect(RefreshTokenRecordSchema.parse(activeToken)).toEqual(activeToken);
    expect(
      RefreshTokenRecordSchema.parse({
        ...activeToken,
        status: "rotated",
        replacement_token_id: ids.replacementToken,
      }),
    ).toMatchObject({ status: "rotated", replacement_token_id: ids.replacementToken });
    expect(() =>
      RefreshTokenRecordSchema.parse({
        ...activeToken,
        replacement_token_id: ids.replacementToken,
      }),
    ).toThrow();
    expect(() => RefreshTokenRecordSchema.parse({ ...activeToken, status: "rotated" })).toThrow();
    expect(() =>
      RefreshTokenRecordSchema.parse({
        ...activeToken,
        status: "revoked",
        replacement_token_id: ids.replacementToken,
      }),
    ).toThrow();
  });

  it("keeps family active and revoked states discriminated and strict", () => {
    expect(RefreshFamilyRecordSchema.parse(activeFamily)).toEqual(activeFamily);
    expect(RefreshFamilyRecordSchema.parse({ ...activeFamily, status: "revoked" })).toMatchObject({
      status: "revoked",
    });
    expect(() => RefreshFamilyRecordSchema.parse({ ...activeFamily, extra: true })).toThrow();
  });
});

describe("A5 refresh rotation and reuse decisions", () => {
  it("plans one active token rotation with an explicit CAS compare block", () => {
    const input = mutationInput();
    const plan = planRefreshMutation(input);

    expect(plan).toEqual({
      kind: "rotate",
      compare: {
        token_id: ids.token,
        token_status: "active",
        family_id: ids.family,
        family_status: "active",
        session_id: ids.session,
        session_version: 4,
      },
      effects: {
        replacement_token_id: ids.replacementToken,
        mark_token_rotated: true,
        revoke_session: false,
      },
    });
    expectDeepFrozen(plan);
    expect(input.token).toEqual(activeToken);
    expect(input.family).toEqual(activeFamily);
    expect(input.session).toEqual(activeSession);
  });

  it("treats a rotated token as reuse and revokes its family and session", () => {
    const plan = planRefreshMutation(
      mutationInput({
        token: {
          ...activeToken,
          status: "rotated",
          replacement_token_id: "fa069359-d900-442d-b10b-3478e37f7156",
        },
      }),
    );

    expect(plan).toEqual({
      kind: "revoke",
      cause: "refresh_reuse",
      revoke_family: true,
      revoke_session: true,
      next_session_version: 5,
    });
    expectDeepFrozen(plan);
  });

  it("rejects an expired rotated token instead of treating it as live reuse", () => {
    const plan = planRefreshMutation(
      mutationInput({
        token: {
          ...activeToken,
          status: "rotated",
          replacement_token_id: "fa069359-d900-442d-b10b-3478e37f7156",
          expires_at: 1_800_000_000,
        },
        now_epoch_seconds: 1_800_000_000,
      }),
    );

    expect(plan).toEqual({ kind: "reject", public_code: "AUTHENTICATION_FAILED" });
    expectDeepFrozen(plan);
  });

  it("uniformly rejects active and rotated mutation at maximum session version", () => {
    const rejected = { kind: "reject", public_code: "AUTHENTICATION_FAILED" };
    const tokens = [
      activeToken,
      {
        ...activeToken,
        status: "rotated" as const,
        replacement_token_id: "fa069359-d900-442d-b10b-3478e37f7156",
      },
    ];

    tokens.forEach((token) => {
      const plan = planRefreshMutation(
        mutationInput({
          token,
          session: { ...activeSession, session_version: Number.MAX_SAFE_INTEGER },
        }),
      );
      expect(plan).toEqual(rejected);
      expectDeepFrozen(plan);
    });
  });

  it("uniformly rejects revoked, expired and unknown tokens without state disclosure", () => {
    const revoked = planRefreshMutation(
      mutationInput({ token: { ...activeToken, status: "revoked" } }),
    );
    const expired = planRefreshMutation(
      mutationInput({
        token: { ...activeToken, expires_at: 1_800_000_000 },
        now_epoch_seconds: 1_800_000_000,
      }),
    );
    const unknown = planRefreshMutation(
      mutationInput({ token: { status: "unknown" }, family: null, session: null }),
    );

    expect(revoked).toEqual({ kind: "reject", public_code: "AUTHENTICATION_FAILED" });
    expect(expired).toEqual(revoked);
    expect(unknown).toEqual(revoked);
    expectDeepFrozen(revoked);
    expectDeepFrozen(expired);
    expectDeepFrozen(unknown);
  });

  it("fails closed when family/session state or identifiers are not current", () => {
    const rejected = { kind: "reject", public_code: "AUTHENTICATION_FAILED" };

    expect(
      planRefreshMutation(mutationInput({ family: { ...activeFamily, status: "revoked" } })),
    ).toEqual(rejected);
    expect(
      planRefreshMutation(mutationInput({ session: { ...activeSession, status: "revoked" } })),
    ).toEqual(rejected);
    expect(
      planRefreshMutation(
        mutationInput({ family: { ...activeFamily, session_id: ids.nextSession } }),
      ),
    ).toEqual(rejected);
  });
});

describe("A5 session/family revocation and replacement", () => {
  it.each(["logout", "refresh_reuse", "pin_switch", "admin_revoke", "credential_change"] as const)(
    "increments session version for %s",
    (cause) => {
      const plan = planRefreshRevocation({ cause, session_version: 4 });

      expect(plan).toEqual({
        kind: "revoke",
        cause,
        revoke_family: true,
        revoke_session: true,
        next_session_version: 5,
      });
      expectDeepFrozen(plan);
    },
  );

  it("rejects session-version overflow instead of wrapping", () => {
    expect(() =>
      planRefreshRevocation({
        cause: "logout",
        session_version: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow();
  });

  it.each(["login", "pin_switch"] as const)(
    "orders %s replacement after revoking the previous family and session",
    (cause) => {
      const plan = planSessionFamilyReplacement({
        cause,
        previous_session_id: ids.session,
        previous_family_id: ids.family,
        previous_session_version: 4,
        next_session_id: ids.nextSession,
        next_family_id: ids.nextFamily,
      });

      expect(plan).toEqual({
        kind: "replace_session_family",
        cause,
        steps: [
          {
            order: 1,
            action: "revoke_previous",
            session_id: ids.session,
            family_id: ids.family,
            next_session_version: 5,
          },
          {
            order: 2,
            action: "create_replacement",
            session_id: ids.nextSession,
            family_id: ids.nextFamily,
          },
        ],
      });
      expectDeepFrozen(plan);
    },
  );

  it("rejects replacement plans that reuse the previous session or family identity", () => {
    const input = {
      cause: "pin_switch",
      previous_session_id: ids.session,
      previous_family_id: ids.family,
      previous_session_version: 4,
      next_session_id: ids.nextSession,
      next_family_id: ids.nextFamily,
    };

    expect(() =>
      planSessionFamilyReplacement({ ...input, next_session_id: ids.session }),
    ).toThrow();
    expect(() => planSessionFamilyReplacement({ ...input, next_family_id: ids.family })).toThrow();
  });
});

describe("A5 refresh CAS and logout distinctions", () => {
  it("classifies one CAS row as committed and zero rows as stale reject", () => {
    const committed = classifyRefreshCasCommit({ matched_rows: 1 });
    const stale = classifyRefreshCasCommit({ matched_rows: 0 });

    expect(committed).toEqual({ kind: "committed" });
    expect(stale).toEqual({
      kind: "stale",
      action: "reload_and_reject",
      public_code: "AUTHENTICATION_FAILED",
    });
    expectDeepFrozen(committed);
    expectDeepFrozen(stale);
    expect(() => classifyRefreshCasCommit({ matched_rows: 2 })).toThrow();
  });

  it("keeps logout storage idempotency distinct from repeated HTTP authentication", () => {
    const revoked = classifyLogoutStorageMutation({
      matched_session_rows: 1,
      matched_family_rows: 1,
    });
    const storageNoOp = classifyLogoutStorageMutation({
      matched_session_rows: 0,
      matched_family_rows: 0,
    });
    const repeatedHttp = classifyLogoutHttpCredential({ refresh_cookie_present: false });

    expect(revoked).toEqual({ kind: "revoked", storage_idempotent: true });
    expect(storageNoOp).toEqual({ kind: "no_op", storage_idempotent: true });
    expect(repeatedHttp).toEqual({
      kind: "reject",
      public_code: "AUTHENTICATION_FAILED",
      http_status: 401,
      client_logged_out: true,
    });
    expect(classifyLogoutHttpCredential({ refresh_cookie_present: true })).toEqual({
      kind: "proceed",
    });
    expectDeepFrozen(revoked);
    expectDeepFrozen(storageNoOp);
    expectDeepFrozen(repeatedHttp);
  });

  it("rejects partial logout storage mutation instead of claiming an atomic revoke", () => {
    expect(() =>
      classifyLogoutStorageMutation({ matched_session_rows: 1, matched_family_rows: 0 }),
    ).toThrow(/atomic/u);
    expect(() =>
      classifyLogoutStorageMutation({ matched_session_rows: 0, matched_family_rows: 1 }),
    ).toThrow(/atomic/u);
  });
});

describe("A5 refresh plain-data security boundary", () => {
  it("rejects accessors without executing them", () => {
    let reads = 0;
    const input = {
      family: activeFamily,
      session: activeSession,
      now_epoch_seconds: 1_800_000_000,
      replacement_token_id: ids.replacementToken,
    } as Record<string, unknown>;
    Object.defineProperty(input, "token", {
      enumerable: true,
      get: () => {
        reads += 1;
        return activeToken;
      },
    });

    expect(() => planRefreshMutation(input)).toThrow(/data property/u);
    expect(reads).toBe(0);
  });

  it.each([
    [Object.assign(new (class {})(), mutationInput()), "class"],
    [{ ...mutationInput(), now_epoch_seconds: new Number(1_800_000_000) }, "boxed"],
    [{ ...mutationInput(), extra: true }, "extra"],
    [
      Object.fromEntries(
        Object.entries(mutationInput()).filter(([key]) => key !== "replacement_token_id"),
      ),
      "missing",
    ],
    [unstableProxy(mutationInput(), "replacement_token_id"), "unstable Proxy"],
  ])("fails closed for malformed %s input", (input, caseName) => {
    expect(() => planRefreshMutation(input), caseName).toThrow();
  });

  it("enforces exact inputs on every auxiliary evaluator", () => {
    expect(() =>
      planRefreshRevocation({ cause: "logout", session_version: 4, extra: true }),
    ).toThrow();
    expect(() => classifyRefreshCasCommit({})).toThrow();
    expect(() =>
      planSessionFamilyReplacement({
        cause: "login",
        previous_session_id: ids.session,
        previous_family_id: ids.family,
        previous_session_version: 4,
        next_session_id: ids.nextSession,
        next_family_id: ids.nextFamily,
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      classifyLogoutStorageMutation({
        matched_session_rows: 1,
        matched_family_rows: 1,
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      classifyLogoutHttpCredential({ refresh_cookie_present: false, extra: true }),
    ).toThrow();
  });

  it("never returns or leaks refresh secrets and hashes", () => {
    const secret = "sensitive-refresh-secret-fragment";
    const outputs = [
      planRefreshMutation(mutationInput()),
      planRefreshRevocation({ cause: "logout", session_version: 4 }),
      classifyRefreshCasCommit({ matched_rows: 0 }),
      classifyLogoutHttpCredential({ refresh_cookie_present: false }),
    ];

    outputs.forEach((output) => {
      const serialized = JSON.stringify(output);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toMatch(/refresh_token|token_hash|refresh_hash|secret/iu);
    });
    let thrown: unknown;
    try {
      planRefreshMutation({ ...mutationInput(), refresh_token: secret });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(secret);
  });
});
