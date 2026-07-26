/**
 * Cookie policy resolves contracts names + local HTTP fallback.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CSRF_COOKIE_NAME, REFRESH_COOKIE_DESCRIPTOR } from "@laundry/contracts";

import {
  csrfCookieClearOptions,
  csrfCookieOptions,
  refreshCookieClearOptions,
  refreshCookieOptions,
  resolveCookiePolicy,
  resolveCookieSecure,
} from "./cookie-policy.js";
import { LOCAL_COOKIE_NAMES, SECURE_COOKIE_NAMES } from "./types.js";

test("secure policy uses __Host- contract names and Secure flags", () => {
  const policy = resolveCookiePolicy({ secure: true });
  assert.equal(policy.refreshName, REFRESH_COOKIE_DESCRIPTOR.name);
  assert.equal(policy.csrfName, CSRF_COOKIE_NAME);
  assert.equal(policy.secure, true);
  assert.equal(policy.sameSite, "strict");
  assert.equal(policy.refreshName.startsWith("__Host-"), true);
  assert.equal(policy.csrfName.startsWith("__Host-"), true);

  const refresh = refreshCookieOptions(policy);
  assert.equal(refresh.secure, true);
  assert.equal(refresh.httpOnly, true);
  assert.equal(refresh.sameSite, "strict");

  const csrf = csrfCookieOptions(policy);
  assert.equal(csrf.secure, true);
  assert.equal(csrf.httpOnly, false);
  assert.equal(csrf.maxAge, REFRESH_COOKIE_DESCRIPTOR.max_age_seconds);
  assert.equal("domain" in csrf, false);

  assert.deepEqual(refreshCookieClearOptions(policy), {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    secure: true,
    maxAge: 0,
  });
  assert.deepEqual(csrfCookieClearOptions(policy), {
    httpOnly: false,
    sameSite: "strict",
    path: "/",
    secure: true,
    maxAge: 0,
  });
});

test("local HTTP policy strips __Host- and disables Secure", () => {
  const policy = resolveCookiePolicy({ secure: false });
  assert.equal(policy.refreshName, "laundry_refresh");
  assert.equal(policy.csrfName, "laundry_csrf");
  assert.equal(policy.secure, false);
  assert.equal(policy.sameSite, "strict");
  assert.equal(refreshCookieClearOptions(policy).secure, false);
  assert.equal(csrfCookieClearOptions(policy).secure, false);
});

test("LOCAL_COOKIE_NAMES and SECURE_COOKIE_NAMES stay aligned", () => {
  assert.equal(LOCAL_COOKIE_NAMES.csrf, "laundry_csrf");
  assert.equal(SECURE_COOKIE_NAMES.csrf, CSRF_COOKIE_NAME);
  assert.equal(SECURE_COOKIE_NAMES.refresh, REFRESH_COOKIE_DESCRIPTOR.name);
});

test("resolveCookieSecure requires an explicit transport flag and never trusts NODE_ENV", () => {
  assert.equal(resolveCookieSecure({ LAUNDRY_COOKIE_SECURE: "1" }), true);
  assert.equal(resolveCookieSecure({ LAUNDRY_COOKIE_SECURE: "true" }), true);
  assert.equal(resolveCookieSecure({ LAUNDRY_COOKIE_SECURE: "0" }), false);
  assert.equal(resolveCookieSecure({ LAUNDRY_COOKIE_SECURE: "false" }), false);
  assert.throws(
    () => resolveCookieSecure({ NODE_ENV: "production" }),
    /LAUNDRY_COOKIE_SECURE must be explicitly configured/u,
  );
  assert.throws(
    () => resolveCookieSecure({ LAUNDRY_COOKIE_SECURE: "sometimes" }),
    /LAUNDRY_COOKIE_SECURE must be 0, 1, false, or true/u,
  );
});
