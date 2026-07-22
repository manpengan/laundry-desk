import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import { PickupPage } from "./PickupPage.js";

test("PickupPage SSR shows load order and collect fields", () => {
  const commandClient = createMockCommandClient();
  const queryClient = createMockQueryClient();

  const html = renderToStaticMarkup(
    createElement(ToastProvider, null, createElement(PickupPage, { commandClient, queryClient })),
  );

  assert.match(html, /取衣/);
  assert.match(html, /订单 ID/);
  assert.match(html, /加载订单/);
  assert.match(html, /本次收款（分）/);
  assert.match(html, /确认取衣/);
  assert.match(html, /勾选要取的衣物/);
  assert.doesNotMatch(html, /件 ID（可选）/);
  assert.doesNotMatch(html, /没有待取件/);
});

test("PickupPage SSR without queryClient still renders form", () => {
  const commandClient = createMockCommandClient();
  const html = renderToStaticMarkup(
    createElement(ToastProvider, null, createElement(PickupPage, { commandClient })),
  );
  assert.match(html, /加载订单/);
  assert.match(html, /确认取衣/);
});
