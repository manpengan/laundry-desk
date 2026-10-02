import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { pickInitialFocus, wrapFocusIndex } from "../lib/focus-trap.js";
import { Dialog } from "./Dialog.js";
import { Drawer } from "./Drawer.js";
import { Banner, Kbd } from "./Feedback.js";
import { Icon, ICON_NAMES } from "./Icon.js";
import { MaskedPhone, maskPhone } from "./MaskedPhone.js";
import { applyNumberPadKey, NumberPad } from "./NumberPad.js";
import { nextEnabledIndex, Tabs } from "./Tabs.js";

test("every icon renders a decorative, CSP-safe stroke svg", () => {
  assert.ok(ICON_NAMES.length >= 30);
  for (const name of ICON_NAMES) {
    const markup = renderToStaticMarkup(createElement(Icon, { name }));
    assert.match(markup, /^<svg class="ld-icon"/u, name);
    assert.match(markup, /aria-hidden="true"/u, name);
    assert.match(markup, /<path d="M/u, name);
    assert.doesNotMatch(markup, /\sstyle=/u, name);
  }
});

test("an icon with a title is exposed as an image", () => {
  const markup = renderToStaticMarkup(createElement(Icon, { name: "printer", title: "打印" }));
  assert.match(markup, /role="img"/u);
  assert.match(markup, /aria-label="打印"/u);
  assert.doesNotMatch(markup, /aria-hidden/u);
});

test("navigation tabs keep button semantics with aria-pressed", () => {
  const markup = renderToStaticMarkup(
    createElement(Tabs<"a" | "b">, {
      label: "生产模块",
      items: [
        { id: "a", label: "件级生产" },
        { id: "b", label: "店厂交接", hint: "F2" },
      ],
      value: "a",
      onChange: () => undefined,
    }),
  );
  assert.match(markup, /role="group" aria-label="生产模块"/u);
  assert.match(markup, /aria-pressed="true"[^>]*>件级生产/u);
  assert.match(markup, /aria-pressed="false"[^>]*>店厂交接<span class="ld-tabs__hint">F2<\/span>/u);
  assert.doesNotMatch(markup, /role="tab"/u);
});

test("radio tabs expose a single checked, roving tab stop", () => {
  const markup = renderToStaticMarkup(
    createElement(Tabs<"light" | "dark">, {
      label: "主题",
      mode: "radio",
      items: [
        { id: "light", label: "浅色" },
        { id: "dark", label: "深色" },
      ],
      value: "dark",
      onChange: () => undefined,
    }),
  );
  assert.match(markup, /role="radiogroup"/u);
  assert.match(markup, /role="radio" aria-checked="false" tabindex="-1"[^>]*>浅色/u);
  assert.match(markup, /role="radio" aria-checked="true" tabindex="0"[^>]*>深色/u);
});

test("arrow keys wrap and skip disabled radio items", () => {
  assert.equal(nextEnabledIndex([false, false, false], 2, 1), 0);
  assert.equal(nextEnabledIndex([false, false, false], 0, -1), 2);
  assert.equal(nextEnabledIndex([false, true, false], 0, 1), 2);
  assert.equal(nextEnabledIndex([true, true], 0, 1), 0);
  assert.equal(nextEnabledIndex([], 0, 1), -1);
});

test("focus trap wraps Tab and prefers explicit autofocus over the close button", () => {
  assert.equal(wrapFocusIndex(2, 3, false), 0);
  assert.equal(wrapFocusIndex(0, 3, true), 2);
  assert.equal(wrapFocusIndex(-1, 3, false), 0);
  assert.equal(wrapFocusIndex(-1, 3, true), 2);
  assert.equal(wrapFocusIndex(0, 0, false), -1);
  const close = { autofocus: false, dismiss: true };
  const field = { autofocus: false, dismiss: false };
  const pinned = { autofocus: true, dismiss: false };
  assert.equal(pickInitialFocus([close, field, pinned]), 2);
  assert.equal(pickInitialFocus([close, field]), 1);
  assert.equal(pickInitialFocus([close]), 0);
  assert.equal(pickInitialFocus([]), -1);
});

test("dialog and drawer use one icon close control named 关闭", () => {
  for (const component of [Dialog, Drawer]) {
    const markup = renderToStaticMarkup(
      createElement(component, {
        open: true,
        title: "打印队列",
        onClose: () => undefined,
        children: createElement("p", null, "暂无打印任务"),
      }),
    );
    assert.match(markup, /role="dialog" aria-modal="true" aria-label="打印队列"/u);
    assert.match(markup, /class="ld-overlay-close" aria-label="关闭"[^>]*data-overlay-dismiss=""/u);
    assert.doesNotMatch(markup, />关闭</u, "the close control is an icon, not a second text label");
    assert.doesNotMatch(markup, /\sstyle=/u);
  }
});

test("banner, kbd and number pad render accessible, CSP-safe markup", () => {
  const banner = renderToStaticMarkup(
    createElement(Banner, {
      tone: "warn",
      title: "门店取送功能已关闭",
      children: "既有订单仍可处理。",
    }),
  );
  assert.match(banner, /class="ld-banner ld-banner--warn" role="status"/u);
  assert.match(banner, /<p class="ld-banner__title">门店取送功能已关闭<\/p>/u);
  assert.equal(
    renderToStaticMarkup(createElement(Kbd, null, "Ctrl")),
    '<kbd class="ld-kbd">Ctrl</kbd>',
  );
  const pad = renderToStaticMarkup(
    createElement(NumberPad, { value: "", onChange: () => undefined }),
  );
  assert.match(pad, /role="group" aria-label="数字键盘"/u);
  assert.equal((pad.match(/class="ld-numpad__key/gu) ?? []).length, 12);
  assert.doesNotMatch(banner + pad, /\sstyle=/u);
});

test("number pad edits are bounded and reversible", () => {
  assert.equal(applyNumberPadKey("12", "3"), "123");
  assert.equal(applyNumberPadKey("123", "backspace"), "12");
  assert.equal(applyNumberPadKey("", "backspace"), "");
  assert.equal(applyNumberPadKey("123", "clear"), "");
  assert.equal(applyNumberPadKey("1234", "5", 4), "1234");
});

test("phones are masked for the counter and server masks are kept", () => {
  assert.equal(maskPhone("13996764629"), "139****4629");
  assert.equal(maskPhone(" 139 9676 4629 "), "139****4629");
  assert.equal(maskPhone("139****4629"), "139****4629");
  assert.equal(maskPhone("02088886666"), "020****6666");
  assert.equal(maskPhone("88886666"), "****6666");
  assert.equal(maskPhone("123"), "***");
  assert.equal(maskPhone(""), "");
});

test("masked phone offers a reveal toggle only when something is hidden", () => {
  const masked = renderToStaticMarkup(createElement(MaskedPhone, { phone: "13996764629" }));
  assert.match(masked, /<span>139\*\*\*\*4629<\/span>/u);
  assert.match(masked, /aria-label="显示完整号码"/u);
  assert.doesNotMatch(masked, /13996764629/u);
  const server = renderToStaticMarkup(createElement(MaskedPhone, { phone: "139****4629" }));
  assert.doesNotMatch(server, /ld-masked__toggle/u);
});
