import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MoneyText } from "./MoneyText.js";

describe("MoneyText", () => {
  it("renders fen as signed currency text", () => {
    const html = renderToStaticMarkup(createElement(MoneyText, { fen: 6000 }));
    assert.match(html, /¥60\.00/);
    assert.match(html, /data-fen="6000"/);
    assert.match(html, /ld-money/);
  });

  it("marks negative amounts", () => {
    const html = renderToStaticMarkup(createElement(MoneyText, { fen: -99 }));
    assert.match(html, /-¥0\.99/);
    assert.match(html, /ld-money--negative/);
  });
});
