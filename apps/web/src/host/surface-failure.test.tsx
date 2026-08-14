import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { ErrorBoundary, SurfaceFailure } from "./SurfaceFailure.js";

// Resolved from the compiled dist/host/ location, matching host-entry.test.ts.
const LAZY_PAGE_HOST_URL = new URL("../../src/pages/LazyPageHost.tsx", import.meta.url);
const HOST_ENTRY_URL = new URL("../../host/main.tsx", import.meta.url);

test("the boundary switches to its fallback once a descendant throws", () => {
  assert.deepEqual(ErrorBoundary.getDerivedStateFromError(), { failed: true });
});

test("the boundary renders children while nothing has failed", () => {
  const markup = renderToStaticMarkup(
    createElement(ErrorBoundary, {
      children: createElement("p", null, "正常"),
      fallback: createElement("p", null, "备用"),
    }),
  );

  assert.match(markup, /正常/u);
  assert.doesNotMatch(markup, /备用/u);
});

test("the failure surface states what broke and offers a reload", () => {
  const markup = renderToStaticMarkup(
    createElement(SurfaceFailure, { title: "页面加载失败", description: "网络中断" }),
  );

  assert.match(markup, /页面加载失败/u);
  assert.match(markup, /网络中断/u);
  assert.match(markup, /role="alert"/u);
  assert.match(markup, /重新加载/u);
});

test("the failure surface never renders a blank region", () => {
  const markup = renderToStaticMarkup(createElement(SurfaceFailure, { title: "标题" }));

  assert.match(markup, /标题/u);
  assert.match(markup, /<button/u);
});

test("lazy routes are wrapped in an error boundary, not only Suspense", async () => {
  const source = await readFile(LAZY_PAGE_HOST_URL, "utf8");

  assert.match(source, /ErrorBoundary/u);
  // The boundary must sit outside Suspense: Suspense resolves pending, the
  // boundary resolves rejection, and a chunk that never arrives is a rejection.
  assert.match(
    source,
    /<ErrorBoundary[\s\S]*<Suspense[\s\S]*<\/Suspense>[\s\S]*<\/ErrorBoundary>/u,
  );
});

test("the host entry handles a rejected startup instead of discarding it", async () => {
  const source = await readFile(HOST_ENTRY_URL, "utf8");

  assert.doesNotMatch(source, /^void start\(\);$/mu);
  assert.match(source, /start\(\)\.catch\(/u);
  assert.match(source, /SurfaceFailure/u);
});
