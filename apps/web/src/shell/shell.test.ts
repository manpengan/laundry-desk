import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { createMockConnection } from "../connection.js";
import { App } from "../App.js";
import { PageHost } from "../pages/PageHost.js";

test("PageHost empty state for receive points to settings copy", () => {
  const html = renderToStaticMarkup(
    createElement(PageHost, {
      activeId: "receive",
      onNavigate: () => undefined,
    }),
  );
  assert.match(html, /开单/);
  assert.match(html, /还没有价目/);
  assert.match(html, /role="status"/);
});

test("PageHost loading exposes aria-busy skeleton", () => {
  const html = renderToStaticMarkup(
    createElement(PageHost, {
      activeId: "workbench",
      loading: true,
      onNavigate: () => undefined,
    }),
  );
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /ld-skeleton/);
});

test("App shell SSR includes skip link, sync bar, print indicator", () => {
  const html = renderToStaticMarkup(
    createElement(App, {
      enableLiquidGlass: false,
      connection: createMockConnection({
        storeName: "宏发演示店",
        mode: "offline",
        pendingSyncCount: 2,
      }),
      themePreference: "light",
    }),
  );
  assert.match(html, /跳到主内容/);
  assert.match(html, /宏发演示店/);
  assert.match(html, /离线/);
  assert.match(html, /data-shell="counter"/);
  assert.match(html, /打印/);
});
