import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider } from "@laundry/ui";
import { createMockAuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { SettingsPage } from "./SettingsPage.js";

test("SettingsPage SSR renders the initial catalog while retaining navigation to unloaded sections", () => {
  const session: SessionView = {
    session: {
      session_id: "s",
      session_version: 1,
      org_id: "o",
      store_id: "store",
      staff_id: "staff",
      device_id: "d",
      permission_version: 1,
    },
    role: "admin",
    features: {},
    display: { store_name: "演示店", staff_name: "测试", org_code: "ORG", store_code: "S1" },
  };
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(SettingsPage, {
        session,
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
      }),
    ),
  );
  assert.match(html, /当前分区：价目维护/u);
  assert.match(html, /aria-current="true"[^>]*>.*?价目维护/u);
  assert.match(html, /id="settings-support"[^>]*hidden=""[^>]*><\/div>/u);
  assert.match(html, /value="settings-support"/u);
  assert.doesNotMatch(html, /data-testid="printer-smoke-section"/u);
  assert.doesNotMatch(html, /#ff0000|rgb\(/iu);
});
