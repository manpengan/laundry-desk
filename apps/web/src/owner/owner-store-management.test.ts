import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { createMockCommandClient } from "../commands/command-client.js";
import { OwnerStoreDirectoryView } from "./OwnerStoreManagementPage.js";
import {
  buildStoreProfileInput,
  parseOwnerStoreDirectory,
  parseUpdatedOwnerStore,
  requestStoreProfileSet,
  resumeStoreProfileSet,
} from "./owner-store-management-model.js";

const CURRENT = Object.freeze({
  store_code: "main",
  store_name: "总店",
  timezone: "Asia/Shanghai",
  profile_version: 3,
  updated_at: "2026-08-11T00:00:00.000Z",
  is_current: true,
});

const BRANCH = Object.freeze({
  store_code: "north",
  store_name: "城北分店",
  timezone: "Pacific/Kiritimati",
  profile_version: 1,
  updated_at: "2026-08-11T00:00:00.000Z",
  is_current: false,
});

test("owner store parser accepts only the bounded exact server projection", () => {
  const parsed = parseOwnerStoreDirectory({
    execution: "executed",
    result: {
      returned_store_count: 2,
      truncated: false,
      stores: [CURRENT, BRANCH],
    },
  });
  assert.ok(parsed);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.stores), true);
  assert.equal(Object.isFrozen(parsed.stores[0]), true);

  assert.equal(
    parseOwnerStoreDirectory({
      returned_store_count: 2,
      truncated: false,
      stores: [{ ...CURRENT, org_id: "must-not-cross-boundary" }, BRANCH],
    }),
    null,
  );
  assert.equal(
    parseOwnerStoreDirectory({
      returned_store_count: 2,
      truncated: false,
      stores: [BRANCH, CURRENT],
    }),
    null,
  );
});

test("owner store rename validates and normalizes the R5 input", () => {
  assert.deepEqual(buildStoreProfileInput(3, "  城南总店  ", "  门头更新  "), {
    ok: true,
    input: {
      expected_profile_version: 3,
      store_name: "城南总店",
      reason: "门头更新",
    },
  });
  assert.deepEqual(buildStoreProfileInput(3, "", "原因"), {
    ok: false,
    message: "门店名称不能为空",
  });
  assert.deepEqual(buildStoreProfileInput(3, "总店", ""), {
    ok: false,
    message: "请填写名称变更原因",
  });
  assert.deepEqual(
    parseUpdatedOwnerStore({ execution: "executed", result: { store: CURRENT } }),
    CURRENT,
  );
});

test("owner store rename resumes only with the server confirmation reference", async () => {
  const calls: Readonly<{ body: unknown; confirmRef?: string }>[] = [];
  const commandClient = createMockCommandClient(
    async <T = unknown>(
      name: string,
      body: unknown = {},
      options?: Readonly<{ confirmRef?: string }>,
    ) => {
      assert.equal(name, "store.profile.set");
      calls.push({
        body,
        ...(options?.confirmRef === undefined ? {} : { confirmRef: options.confirmRef }),
      });
      return Object.freeze({ ok: true as const, data: Object.freeze({ result: {} }) as T });
    },
  );
  const built = buildStoreProfileInput(3, "城南总店", "门头更新");
  assert.equal(built.ok, true);
  if (!built.ok) return;

  await requestStoreProfileSet(commandClient, built.input);
  await resumeStoreProfileSet(commandClient, "00000000-0000-4000-8000-000000000040");
  assert.deepEqual(calls, [
    { body: built.input },
    { body: {}, confirmRef: "00000000-0000-4000-8000-000000000040" },
  ]);
});

test("owner store directory exposes re-login switching without cross-store edit controls", () => {
  const html = renderToStaticMarkup(
    createElement(OwnerStoreDirectoryView, {
      directory: {
        returned_store_count: 2,
        truncated: false,
        stores: [CURRENT, BRANCH],
      },
      switchingStore: null,
      onSelectStore: () => undefined,
    }),
  );
  assert.match(html, /授权门店/u);
  assert.match(html, /城北分店/u);
  assert.match(html, /切换门店会先退出当前会话/u);
  assert.match(html, /切换登录/u);
  assert.doesNotMatch(html, /org_id|store_id|删除门店|修改时区/u);
});
