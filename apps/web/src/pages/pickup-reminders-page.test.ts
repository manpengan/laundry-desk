import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";

import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import { PickupRemindersPage } from "./PickupRemindersPage.js";

test("pickup reminders SSR names the manual fallback without claiming delivery", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(PickupRemindersPage, {
        commandClient: createMockCommandClient(),
        queryClient: createMockQueryClient(),
      }),
    ),
  );
  assert.match(html, /催取工作台/);
  assert.match(html, /短信、微信未接入/);
  assert.match(html, /生成名单并复制号码/);
  assert.doesNotMatch(html, /已发送|送达|通知成功/u);
});
