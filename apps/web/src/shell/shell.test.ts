import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { createMockConnection } from "../connection.js";
import { App } from "../App.js";
import { WorkbenchPlaceholder } from "./WorkbenchPlaceholder.js";

test("WorkbenchPlaceholder renders MoneyText fen demo", () => {
  const html = renderToStaticMarkup(createElement(WorkbenchPlaceholder, { activeId: "workbench" }));
  assert.match(html, /工作台/);
  assert.match(html, /¥1286\.50/);
});

test("App shell SSR includes nav and connection strip", () => {
  const html = renderToStaticMarkup(
    createElement(App, {
      enableLiquidGlass: false,
      connection: createMockConnection({
        storeName: "宏发演示店",
        pendingSyncCount: 0,
      }),
      themePreference: "light",
    }),
  );
  assert.match(html, /宏发演示店/);
  assert.match(html, /在线/);
  assert.match(html, /工作台|开单|取衣/);
  assert.match(html, /data-shell="counter"/);
});
