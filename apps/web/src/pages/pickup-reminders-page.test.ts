import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { FULL_STORE_FEATURES } from "../auth/permissions.js";
import type { SessionView } from "../auth/types.js";

import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import { PickupRemindersPage } from "./PickupRemindersPage.js";

const SESSION: SessionView = Object.freeze({
  session: Object.freeze({
    session_id: "aaaaaaaa-bbbb-4ccc-8ddd-111111111111",
    session_version: 1,
    org_id: "aaaaaaaa-bbbb-4ccc-8ddd-222222222222",
    store_id: "aaaaaaaa-bbbb-4ccc-8ddd-333333333333",
    staff_id: "11111111-1111-4111-8111-111111111101",
    device_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    permission_version: 1,
  }),
  role: "admin",
  features: FULL_STORE_FEATURES,
  display: Object.freeze({
    store_name: "测试店",
    staff_name: "测试店长",
    org_code: "ORG",
    store_code: "S1",
  }),
});

test("pickup reminders SSR names the manual fallback without claiming delivery", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(PickupRemindersPage, {
        commandClient: createMockCommandClient(),
        queryClient: createMockQueryClient(),
        session: SESSION,
      }),
    ),
  );
  assert.match(html, /催取工作台/);
  assert.match(html, /不会自行发送短信或微信/);
  assert.match(html, /自动通知通道/);
  assert.match(html, /正在读取通道保证级别/);
  assert.match(html, /生成名单并复制号码/);
  assert.doesNotMatch(html, /已发送|送达|通知成功/u);
});
