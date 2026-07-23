import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockQueryClient } from "../commands/query-client.js";
import { buildDebtReminderText, copyTextToClipboard, DebtPage } from "./DebtPage.js";

test("buildDebtReminderText formats phone + integer fen balance", () => {
  const text = buildDebtReminderText({
    ticket_no: "20260722-0001",
    customer_name: "甲",
    customer_phone: "13800000111",
    balance_cents: 2500,
  });
  assert.match(text, /催付/);
  assert.match(text, /甲/);
  assert.match(text, /13800000111/);
  assert.match(text, /20260722-0001/);
  assert.match(text, /¥25\.00/);
  assert.doesNotMatch(text, /25\.0[^0]/);
});

test("buildDebtReminderText falls back when name/phone missing", () => {
  const text = buildDebtReminderText({
    ticket_no: "T-2",
    customer_name: null,
    customer_phone: null,
    balance_cents: 100,
  });
  assert.match(text, /客户/);
  assert.match(text, /无手机号/);
  assert.match(text, /¥1\.00/);
});

test("buildDebtReminderText rejects non-integer fen via formatMoneyFromFen", () => {
  assert.throws(
    () =>
      buildDebtReminderText({
        ticket_no: "T-3",
        customer_name: "乙",
        customer_phone: "13800000222",
        balance_cents: 10.5,
      }),
    /integer fen/i,
  );
});

test("copyTextToClipboard is SSR-safe (no navigator.clipboard)", async () => {
  const ok = await copyTextToClipboard("hello");
  assert.equal(ok, false);
});

test("DebtPage SSR shell shows load control and empty prompt", () => {
  const queryClient = createMockQueryClient();
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(DebtPage, {
        queryClient,
      }),
    ),
  );

  assert.match(html, /欠款/);
  assert.match(html, /data-testid="debt-section"/);
  assert.match(html, /data-testid="debt-load-btn"/);
  assert.match(html, /data-testid="debt-list"/);
  assert.match(html, /加载欠款/);
  assert.match(html, /点击「加载欠款」查看应收/);
  assert.doesNotMatch(html, /#ff0000/i);
  assert.doesNotMatch(html, /rgb\(/i);
});

test("DebtPage SSR with onOpenPickup still omits rows until load", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(DebtPage, {
        queryClient: createMockQueryClient(),
        onOpenPickup: () => undefined,
      }),
    ),
  );
  assert.match(html, /data-testid="debt-load-btn"/);
  assert.doesNotMatch(html, /data-testid="debt-row"/);
  assert.doesNotMatch(html, /data-testid="debt-row-copy-btn"/);
  assert.doesNotMatch(html, /data-testid="debt-row-pickup-btn"/);
});
