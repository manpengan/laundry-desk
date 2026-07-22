/**
 * Cookie policy resolves contracts names + local HTTP fallback.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CSRF_COOKIE_NAME, REFRESH_COOKIE_DESCRIPTOR } from "@laundry/contracts";

import {
  csrfCookieOptions,
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
});

test("local HTTP policy strips __Host- and disables Secure", () => {
  const policy = resolveCookiePolicy({ secure: false });
  assert.equal(policy.refreshName, "laundry_refresh");
  assert.equal(policy.csrfName, "laundry_csrf");
  assert.equal(policy.secure, false);
  assert.equal(policy.sameSite, "strict");
});

test("LOCAL_COOKIE_NAMES and SECURE_COOKIE_NAMES stay aligned", () => {
  assert.equal(LOCAL_COOKIE_NAMES.csrf, "laundry_csrf");
  assert.equal(SECURE_COOKIE_NAMES.csrf, CSRF_COOKIE_NAME);
  assert.equal(SECURE_COOKIE_NAMES.refresh, REFRESH_COOKIE_DESCRIPTOR.name);
});

test("resolveCookieSecure respects LAUNDRY_COOKIE_SECURE and NODE_ENV", () => {
  assert.equal(resolveCookieSecure({ LAUNDRY_COOKIE_SECURE: "1" }), true);
  assert.equal(resolveCookieSecure({ LAUNDRY_COOKIE_SECURE: "0" }), false);
  assert.equal(resolveCookieSecure({ NODE_ENV: "production" }), true);
  assert.equal(resolveCookieSecure({ NODE_ENV: "development" }), false);
});
