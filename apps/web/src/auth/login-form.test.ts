import assert from "node:assert/strict";
import test from "node:test";

import { DESKTOP_LOGIN_WORKSPACE } from "../host/desktop-login-workspace.js";
import { initialLoginForm } from "./login-form.js";
import { validateLoginForm } from "./validate-login.js";

const REMEMBERED = Object.freeze({ org_code: "ORG", store_code: "S1" });

test("a bound workspace replaces remembered and prefilled store codes", () => {
  const form = initialLoginForm(
    { org_code: "OTHER", store_code: "S9", username: "clerk" },
    DESKTOP_LOGIN_WORKSPACE,
    REMEMBERED,
  );

  assert.deepEqual(form, {
    org_code: "local",
    store_code: "main",
    username: "clerk",
    password: "",
  });
});

test("without a bound workspace remembered codes seed the form and a prefill wins", () => {
  assert.deepEqual(initialLoginForm(undefined, undefined, REMEMBERED), {
    org_code: "ORG",
    store_code: "S1",
    username: "",
    password: "",
  });
  assert.deepEqual(initialLoginForm({ store_code: "S2" }, undefined, REMEMBERED), {
    org_code: "ORG",
    store_code: "S2",
    username: "",
    password: "",
  });
  assert.deepEqual(initialLoginForm(undefined, undefined, null), {
    org_code: "",
    store_code: "",
    username: "",
    password: "",
  });
});

test("the desktop workspace passes login validation, leaving only the account to fill", () => {
  const errors = validateLoginForm(initialLoginForm(undefined, DESKTOP_LOGIN_WORKSPACE, null));

  assert.deepEqual(Object.keys(errors).sort(), ["password", "username"]);
});
