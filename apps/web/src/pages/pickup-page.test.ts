import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockCommandClient } from "../commands/command-client.js";
import { PickupPage } from "./PickupPage.js";

test("PickupPage SSR shows order_id collect and empty garment hint", () => {
  const commandClient = createMockCommandClient();

  const html = renderToStaticMarkup(
    createElement(ToastProvider, null, createElement(PickupPage, { commandClient })),
  );

  assert.match(html, /取衣/);
  assert.match(html, /订单 ID/);
  assert.match(html, /本次收款（分）/);
  assert.match(html, /件 ID（可选）/);
  assert.match(html, /全部可取件/);
  assert.match(html, /确认取衣/);
  assert.doesNotMatch(html, /没有待取件/);
});
