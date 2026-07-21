import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { EmptyState } from "./EmptyState.js";

test("EmptyState renders title and optional action", () => {
  const html = renderToStaticMarkup(
    createElement(EmptyState, {
      title: "还没有价目",
      description: "先添加品类",
      actionLabel: "添加品类",
      onAction: () => undefined,
    }),
  );
  assert.match(html, /还没有价目/);
  assert.match(html, /先添加品类/);
  assert.match(html, /添加品类/);
  assert.match(html, /role="status"/);
});
