import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockCommandClient } from "../commands/command-client.js";
import { ReceivePage } from "./ReceivePage.js";

test("ReceivePage SSR shows form fields and submit", () => {
  const commandClient = createMockCommandClient();

  const html = renderToStaticMarkup(
    createElement(ToastProvider, null, createElement(ReceivePage, { commandClient })),
  );

  assert.match(html, /开单/);
  assert.match(html, /手机号/);
  assert.match(html, /衣物明细/);
  assert.match(html, /单价（分）/);
  assert.match(html, /已付（分）/);
  assert.match(html, /确认开单/);
  assert.match(html, /整数分/);
  assert.doesNotMatch(html, /还没有价目/);
});
