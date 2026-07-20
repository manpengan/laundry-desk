import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusBadge } from "./StatusBadge.js";

describe("StatusBadge", () => {
  it("encodes color class and shape data attribute", () => {
    const html = renderToStaticMarkup(
      createElement(StatusBadge, { family: "print", status: "failed" }),
    );
    assert.match(html, /ld-badge--danger/);
    assert.match(html, /data-shape="square"/);
    assert.match(html, /失败/);
    assert.match(html, /<svg/);
  });

  it("shows sync offline with triangle", () => {
    const html = renderToStaticMarkup(
      createElement(StatusBadge, { family: "sync", status: "offline" }),
    );
    assert.match(html, /ld-badge--warn/);
    assert.match(html, /data-shape="triangle"/);
  });
});
