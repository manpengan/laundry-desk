import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider } from "@laundry/ui";

import { createMockAuthClient } from "../auth/AuthClient.js";
import { StaffCredentialSetupForm } from "./StaffCredentialSetupForm.js";

import {
  buildCredentialCompletion,
  buildStaffCreateBody,
  buildStaffCredentialsResetBody,
  parseStaffCredentialSetup,
  parseStaffCredentialsCompleteResult,
} from "./staff-credentials.js";

const SETUP_REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAFF_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("staff create trims metadata and never introduces credential fields", () => {
  const result = buildStaffCreateBody({
    username: "new.admin",
    display_name: " 新店长 ",
    role: "admin",
    privacy_admin: true,
    reason: " 新店交接 ",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.body, {
    username: "new.admin",
    display_name: "新店长",
    role: "admin",
    privacy_admin: true,
    reason: "新店交接",
  });
  assert.doesNotMatch(JSON.stringify(result.body), /password|pin|credential/iu);
});

test("staff create rejects invalid fields in focus order and strips staff privacy authority", () => {
  assert.deepEqual(
    buildStaffCreateBody({
      username: "bad name",
      display_name: "",
      role: "staff",
      privacy_admin: true,
      reason: "",
    }),
    {
      ok: false,
      field: "username",
      message: "登录名须为 1–128 位可见 ASCII 字符，不能含空格",
    },
  );
  const valid = buildStaffCreateBody({
    username: "clerk-1",
    display_name: "店员一",
    role: "staff",
    privacy_admin: true,
    reason: "入职",
  });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.body.privacy_admin, false);
});

test("credential completion validates password and 6-8 digit PIN without persisting confirmations", () => {
  const valid = buildCredentialCompletion(SETUP_REF, {
    password: "correct-horse-battery",
    password_confirmation: "correct-horse-battery",
    pin: "864209",
    pin_confirmation: "864209",
  });
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.deepEqual(Object.keys(valid.body).sort(), ["credential_setup_ref", "password", "pin"]);

  const short = buildCredentialCompletion(SETUP_REF, {
    password: "too-short",
    password_confirmation: "too-short",
    pin: "123456",
    pin_confirmation: "123456",
  });
  assert.deepEqual(short, { ok: false, field: "password", message: "密码须为 12–256 个字符" });
  const unicodePin = buildCredentialCompletion(SETUP_REF, {
    password: "correct-horse-battery",
    password_confirmation: "correct-horse-battery",
    pin: "１２３４５６",
    pin_confirmation: "１２３４５６",
  });
  assert.equal(unicodePin.ok, false);
});

test("staff credential reset is validated by the frozen contract and trims only the reason", () => {
  assert.deepEqual(
    buildStaffCredentialsResetBody({
      target_staff_id: STAFF_ID,
      expected_permission_version: 2,
      reason: "  定期轮换  ",
    }),
    {
      ok: true,
      body: {
        target_staff_id: STAFF_ID,
        expected_permission_version: 2,
        reason: "定期轮换",
      },
    },
  );
  assert.deepEqual(
    buildStaffCredentialsResetBody({
      target_staff_id: STAFF_ID,
      expected_permission_version: 2,
      reason: " ",
    }),
    { ok: false, field: "reason", message: "重置原因须为 1–256 个字符" },
  );
});

test("credential setup and completion parsers reject unknown or secret-bearing fields", () => {
  const setup = {
    credential_setup_ref: SETUP_REF,
    target_staff_id: STAFF_ID,
    expires_at: 1_800_000_000,
    status: "pending",
  };
  assert.deepEqual(parseStaffCredentialSetup({ execution: "executed", result: setup }), setup);
  assert.equal(parseStaffCredentialSetup({ ...setup, password: "secret" }), null);

  const completed = {
    target_staff_id: STAFF_ID,
    permission_version: 2,
    status: "active",
  };
  assert.deepEqual(parseStaffCredentialsCompleteResult(completed), completed);
  assert.equal(
    parseStaffCredentialsCompleteResult({ ...completed, credential_setup_ref: SETUP_REF }),
    null,
  );
});

test("credential form exposes visible labels, numeric PIN inputs, and 44px component controls", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(StaffCredentialSetupForm, {
        setup: {
          credential_setup_ref: SETUP_REF,
          target_staff_id: STAFF_ID,
          expires_at: 1_800_000_000,
          status: "pending",
        },
        authClient: createMockAuthClient(),
        onCompleted: () => undefined,
        onCancel: () => undefined,
      }),
    ),
  );
  assert.match(html, /新密码/u);
  assert.match(html, /再次输入新密码/u);
  assert.match(html, /新 PIN（6–8 位数字）/u);
  assert.equal((html.match(/inputmode="numeric"/giu) ?? []).length, 2);
  assert.match(html, /aria-live="assertive"|ld-staff-form__error/u);
  assert.doesNotMatch(html, new RegExp(SETUP_REF, "u"));
});
