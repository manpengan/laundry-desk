import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  printIndicatorLabel,
  printIndicatorStatus,
  PrintJobIndicator,
} from "./PrintJobIndicator.js";

test("printIndicator helpers prioritize failed over queued", () => {
  assert.equal(printIndicatorStatus({ queued: 2, failed: 1 }), "failed");
  assert.equal(printIndicatorStatus({ queued: 2, failed: 0 }), "queued");
  assert.equal(printIndicatorStatus({ queued: 0, failed: 0 }), "done");
  assert.match(printIndicatorLabel({ queued: 0, failed: 2 }), /失败/);
});

test("PrintJobIndicator SSR exposes counts", () => {
  const html = renderToStaticMarkup(
    createElement(PrintJobIndicator, {
      summary: { queued: 1, failed: 0 },
    }),
  );
  assert.match(html, /data-queued="1"/);
  assert.match(html, /排队/);
});
