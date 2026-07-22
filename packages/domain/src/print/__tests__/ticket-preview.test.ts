import { describe, expect, it } from "vitest";

import { YUAN_SIGN_UI, renderTicketPreview, type TicketPreviewInput } from "../ticket-preview.js";

const base: TicketPreviewInput = Object.freeze({
  store_name: "测试洗衣店",
  store_phone: "010-88886666",
  ticket_no: "20260722-0001",
  customer_name: "张三",
  customer_phone: "13800000111",
  receive_date: "2026-07-22",
  lines: Object.freeze([
    Object.freeze({ name: "wash/shirt", qty: 2, unit_price_cents: 1500 }),
    Object.freeze({ name: "dry/coat", qty: 1, unit_price_cents: 4500 }),
  ]),
  payable_cents: 7500,
  paid_cents: 2000,
  balance_cents: 5500,
  notice_lines: Object.freeze(["请凭票取衣", "保管期 30 天"]),
});

describe("renderTicketPreview", () => {
  it("renders happy-path 58mm layout with halfwidth yen", () => {
    const preview = renderTicketPreview(base);

    expect(YUAN_SIGN_UI).toBe("\u00A5");
    expect(preview.total_text).toBe(`${YUAN_SIGN_UI}75.00`);
    expect(preview.paid_text).toBe(`${YUAN_SIGN_UI}20.00`);
    expect(preview.balance_text).toBe(`${YUAN_SIGN_UI}55.00`);
    expect(preview.total_text.startsWith("¥")).toBe(true);
    expect(preview.total_text.startsWith("\uFFE5")).toBe(false);

    expect(preview.lines[0]).toBe("测试洗衣店");
    expect(preview.lines).toContain("电话 010-88886666");
    expect(preview.lines).toContain("票单号 20260722-0001");
    expect(preview.lines).toContain("收件 2026-07-22");
    expect(preview.lines).toContain("顾客 张三 13800000111");
    expect(preview.lines).toContain(`wash/shirt  x2  ${YUAN_SIGN_UI}30.00`);
    expect(preview.lines).toContain(`dry/coat  x1  ${YUAN_SIGN_UI}45.00`);
    expect(preview.lines).toContain(`合计 ${YUAN_SIGN_UI}75.00`);
    expect(preview.lines).toContain(`实收 ${YUAN_SIGN_UI}20.00`);
    expect(preview.lines).toContain(`余额 ${YUAN_SIGN_UI}55.00`);
    expect(preview.lines).toContain("请凭票取衣");
    expect(preview.lines).toContain("保管期 30 天");
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.lines)).toBe(true);
  });

  it("omits phone and uses dash customer when missing", () => {
    const preview = renderTicketPreview({
      store_name: base.store_name,
      ticket_no: base.ticket_no,
      customer_name: null,
      customer_phone: null,
      receive_date: base.receive_date,
      lines: base.lines,
      payable_cents: base.payable_cents,
      paid_cents: base.paid_cents,
      balance_cents: base.balance_cents,
    });
    expect(preview.lines.some((l) => l.startsWith("电话 "))).toBe(false);
    expect(preview.lines).toContain("顾客 —");
  });

  it("throws on non-integer fen for money fields", () => {
    expect(() => renderTicketPreview({ ...base, payable_cents: 10.5 })).toThrow(/integer/i);
    expect(() => renderTicketPreview({ ...base, paid_cents: 1.1 })).toThrow(/integer/i);
    expect(() => renderTicketPreview({ ...base, balance_cents: 0.01 })).toThrow(/integer/i);
    expect(() =>
      renderTicketPreview({
        ...base,
        lines: [{ name: "x", qty: 1, unit_price_cents: 0.3 }],
      }),
    ).toThrow(/integer/i);
  });

  it("throws on non-positive qty", () => {
    expect(() =>
      renderTicketPreview({
        ...base,
        lines: [{ name: "x", qty: 0, unit_price_cents: 100 }],
      }),
    ).toThrow(/positive integer/i);
    expect(() =>
      renderTicketPreview({
        ...base,
        lines: [{ name: "x", qty: 1.5, unit_price_cents: 100 }],
      }),
    ).toThrow(/positive integer/i);
  });
});
