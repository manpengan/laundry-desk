import { describe, expect, it } from "vitest";

import {
  CSRF_COOKIE_CLEAR_DESCRIPTOR,
  CSRF_COOKIE_DESCRIPTOR,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CsrfProofSchema,
  evaluateCsrfRequest,
  evaluateLoginPreAuthOrigin,
  validateCsrfTransportProofs,
} from "../src/auth/csrf.js";

const proof = (character: string, length = 43): string => `v1.${character.repeat(length)}`;

const cookieProof = proof("A");
const headerProof = proof("B");

const requestFacts = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  method: "POST",
  origin_allowed: true,
  fetch_site: "same-origin",
  cookie_present: true,
  header_present: true,
  tokens_match: true,
  proof_valid: true,
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

const captureError = (action: () => unknown): unknown => {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
};

describe("A5 CSRF cookie and header contract", () => {
  it("freezes the exact readable __Host CSRF cookie and header names", () => {
    expect(CSRF_COOKIE_NAME).toBe("__Host-laundry_csrf");
    expect(CSRF_HEADER_NAME).toBe("x-csrf-token");
    expect(CSRF_COOKIE_DESCRIPTOR).toEqual({
      name: "__Host-laundry_csrf",
      secure: true,
      http_only: false,
      same_site: "strict",
      path: "/",
    });
    expect("domain" in CSRF_COOKIE_DESCRIPTOR).toBe(false);
    expect("max_age_seconds" in CSRF_COOKIE_DESCRIPTOR).toBe(false);
    expectDeepFrozen(CSRF_COOKIE_DESCRIPTOR);
  });

  it("freezes logout clearing with the identical scope and Max-Age zero", () => {
    expect(CSRF_COOKIE_CLEAR_DESCRIPTOR).toEqual({
      ...CSRF_COOKIE_DESCRIPTOR,
      max_age_seconds: 0,
    });
    expect("domain" in CSRF_COOKIE_CLEAR_DESCRIPTOR).toBe(false);
    expectDeepFrozen(CSRF_COOKIE_CLEAR_DESCRIPTOR);
  });
});

describe("A5 versioned opaque CSRF proof", () => {
  it("accepts only v1 base64url proofs from 43 through 128 opaque characters", () => {
    expect(CsrfProofSchema.parse(proof("A", 43))).toBe(proof("A", 43));
    expect(CsrfProofSchema.parse(proof("_", 128))).toBe(proof("_", 128));

    [
      proof("A", 42),
      proof("A", 129),
      `v1.${"A".repeat(42)}=`,
      `v1.${"A".repeat(42)} `,
      `v2.${"A".repeat(43)}`,
    ].forEach((candidate) => expect(() => CsrfProofSchema.parse(candidate)).toThrow());
  });

  it("validates cookie and header syntax independently without comparing them", () => {
    const result = validateCsrfTransportProofs({
      cookie_token: cookieProof,
      header_token: headerProof,
    });

    expect(result).toEqual({ valid: true });
    expectDeepFrozen(result);
    expect(JSON.stringify(result)).not.toMatch(/cookie|header|token|proof|v1\./iu);
  });

  it("rejects a malformed cookie or header proof independently", () => {
    expect(() =>
      validateCsrfTransportProofs({
        cookie_token: `v1.${"A".repeat(42)}=`,
        header_token: headerProof,
      }),
    ).toThrow();
    expect(() =>
      validateCsrfTransportProofs({
        cookie_token: cookieProof,
        header_token: `v1.${"B".repeat(42)}=`,
      }),
    ).toThrow();
  });

  it("uses an exact plain-data snapshot without executing token accessors", () => {
    let getterCalls = 0;
    const input = { header_token: headerProof } as Record<string, unknown>;
    Object.defineProperty(input, "cookie_token", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return cookieProof;
      },
    });

    expect(() => validateCsrfTransportProofs(input)).toThrow();
    expect(getterCalls).toBe(0);
  });

  it("rejects class, boxed, extra, missing and unstable proof containers", () => {
    class ProofContainer {
      cookie_token = cookieProof;
      header_token = headerProof;
    }

    const valid = { cookie_token: cookieProof, header_token: headerProof };
    [
      new ProofContainer(),
      new String(cookieProof),
      { ...valid, extra: true },
      { cookie_token: cookieProof },
      unstableProxy(valid, "cookie_token"),
    ].forEach((input) => expect(() => validateCsrfTransportProofs(input)).toThrow());
  });

  it("never echoes malformed proof contents in errors", () => {
    const sensitive = `v1.${"sensitive_".repeat(6)}=`;
    const error = captureError(() =>
      validateCsrfTransportProofs({ cookie_token: sensitive, header_token: headerProof }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(sensitive);
  });
});

describe("A5 CSRF request evaluator", () => {
  it.each(["GET", "HEAD", "OPTIONS"] as const)(
    "treats %s as safe without requiring double-submit facts",
    (method) => {
      const decision = evaluateCsrfRequest(
        requestFacts({
          method,
          origin_allowed: false,
          fetch_site: "cross-site",
          cookie_present: false,
          header_present: false,
          tokens_match: false,
          proof_valid: false,
        }),
      );

      expect(decision).toEqual({ allowed: true });
      expectDeepFrozen(decision);
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "requires and accepts complete same-origin double-submit facts for %s",
    (method) => {
      const decision = evaluateCsrfRequest(requestFacts({ method }));
      expect(decision).toEqual({ allowed: true });
      expectDeepFrozen(decision);
    },
  );

  it("accepts an allowlisted same-site unsafe request", () => {
    expect(evaluateCsrfRequest(requestFacts({ fetch_site: "same-site" }))).toEqual({
      allowed: true,
    });
  });

  it.each([
    [{ origin_allowed: false }, "ORIGIN_NOT_ALLOWED"],
    [{ fetch_site: "cross-site" }, "FETCH_METADATA_REJECTED"],
    [{ fetch_site: "none" }, "FETCH_METADATA_REJECTED"],
    [{ cookie_present: false }, "TOKEN_MISSING"],
    [{ header_present: false }, "TOKEN_MISSING"],
    [{ tokens_match: false }, "TOKEN_MISMATCH"],
    [{ proof_valid: false }, "PROOF_INVALID"],
  ] as const)("rejects unsafe facts with fixed reason %s", (overrides, reason) => {
    const decision = evaluateCsrfRequest(requestFacts(overrides));
    expect(decision).toEqual({ allowed: false, reason });
    expectDeepFrozen(decision);
  });

  it("does not accept a login-style exemption mode or any raw token", () => {
    const error = captureError(() =>
      evaluateCsrfRequest({
        ...requestFacts(),
        operation: "login",
        cookie_token: cookieProof,
        header_token: headerProof,
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(cookieProof);
    expect(String(error)).not.toContain(headerProof);
  });
});

describe("A5 login-only pre-auth Origin evaluator", () => {
  it.each(["same-origin", "same-site"] as const)(
    "allows login POST from an allowlisted %s request without CSRF facts",
    (fetchSite) => {
      const decision = evaluateLoginPreAuthOrigin({
        method: "POST",
        origin_allowed: true,
        fetch_site: fetchSite,
      });
      expect(decision).toEqual({ allowed: true });
      expectDeepFrozen(decision);
    },
  );

  it.each([
    [{ method: "POST", origin_allowed: false, fetch_site: "same-origin" }, "ORIGIN_NOT_ALLOWED"],
    [{ method: "POST", origin_allowed: true, fetch_site: "cross-site" }, "FETCH_METADATA_REJECTED"],
    [{ method: "POST", origin_allowed: true, fetch_site: "none" }, "FETCH_METADATA_REJECTED"],
  ] as const)("fails login pre-auth closed with %s", (facts, reason) => {
    const decision = evaluateLoginPreAuthOrigin(facts);
    expect(decision).toEqual({ allowed: false, reason });
    expectDeepFrozen(decision);
  });
});

describe("A5 CSRF plain-data security boundary", () => {
  it("rejects request accessors without executing them", () => {
    let getterCalls = 0;
    const input = requestFacts();
    Object.defineProperty(input, "method", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "POST";
      },
    });

    expect(() => evaluateCsrfRequest(input)).toThrow();
    expect(getterCalls).toBe(0);
  });

  it("rejects class, boxed, extra, missing and unstable request facts", () => {
    class RequestFacts {
      method = "POST";
      origin_allowed = true;
      fetch_site = "same-origin";
      cookie_present = true;
      header_present = true;
      tokens_match = true;
      proof_valid = true;
    }

    const valid = requestFacts();
    [
      new RequestFacts(),
      new Boolean(true),
      { ...valid, extra: true },
      { ...valid, proof_valid: undefined },
      unstableProxy(valid, "method"),
    ].forEach((input) => expect(() => evaluateCsrfRequest(input)).toThrow());
  });

  it("enforces exact plain login pre-auth facts", () => {
    const valid = { method: "POST", origin_allowed: true, fetch_site: "same-origin" };
    [
      { ...valid, extra: true },
      { method: "POST", origin_allowed: true },
      { ...valid, method: "GET" },
      unstableProxy(valid, "fetch_site"),
    ].forEach((input) => expect(() => evaluateLoginPreAuthOrigin(input)).toThrow());
  });

  it("never returns transport proofs or secret-like fields", () => {
    const outputs = [
      validateCsrfTransportProofs({ cookie_token: cookieProof, header_token: headerProof }),
      evaluateCsrfRequest(requestFacts()),
      evaluateCsrfRequest(requestFacts({ tokens_match: false })),
      evaluateLoginPreAuthOrigin({
        method: "POST",
        origin_allowed: false,
        fetch_site: "same-origin",
      }),
    ];

    outputs.forEach((output) => {
      const serialized = JSON.stringify(output);
      expect(serialized).not.toContain(cookieProof);
      expect(serialized).not.toContain(headerProof);
      expect(serialized).not.toMatch(/cookie_token|header_token|secret|hash|v1\./iu);
    });
  });
});
