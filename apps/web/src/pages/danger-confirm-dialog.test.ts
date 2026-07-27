import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { DangerConfirmDialog } from "./DangerConfirmDialog.js";

test("DangerConfirmDialog requires a reason and renders the irreversible warning", () => {
  const html = renderToStaticMarkup(
    createElement(DangerConfirmDialog, {
      open: true,
      title: "撤销订单",
      description: "不能撤回。",
      confirmLabel: "确认撤销",
      onClose: () => undefined,
      onConfirm: () => undefined,
    }),
  );
  assert.match(html, /操作原因/);
  assert.match(html, /不能撤回/);
  assert.match(html, /确认撤销/);
  assert.match(html, /disabled=""/);
});
