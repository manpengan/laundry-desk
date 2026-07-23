/**
 * 工作台订单历史 — order.list (M2 skeleton).
 */

import { Button, Input, MoneyText, StatusBadge, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryPort } from "../commands/types.js";
import { OrderDetailDrawer } from "./OrderDetailDrawer.js";

export type OrderListRowView = Readonly<{
  order_id: string;
  ticket_no: string;
  status: string;
  customer_phone: string | null;
  customer_name: string | null;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  created_at: number;
  garment_count?: number;
}>;

export type OrdersListProps = {
  queryClient: QueryPort;
  /** Override default date (tests / local calendar). Empty string = all days. */
  defaultDate?: string;
  /** Skip auto-load on mount (tests). */
  autoLoad?: boolean;
  /** Navigate to pickup with order id prefilled (drawer 去取衣). */
  onOpenPickup?: (orderId: string) => void;
};

/** Local calendar YYYY-MM-DD (counter default day). */
export function localYmd(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Unwrap bus `{ execution, result }` or bare result. */
export function unwrapQueryResult(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if ("result" in data) return data.result;
  return data;
}

export function parseOrderListRows(value: unknown): readonly OrderListRowView[] | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.orders)) return null;
  const rows: OrderListRowView[] = [];
  for (const item of value.orders) {
    if (!isRecord(item)) return null;
    if (typeof item.order_id !== "string") return null;
    if (typeof item.ticket_no !== "string") return null;
    if (typeof item.status !== "string") return null;
    const payable = asInt(item.payable_cents);
    const paid = asInt(item.paid_cents);
    const balance = asInt(item.balance_cents);
    const created = asInt(item.created_at);
    if (payable === null || paid === null || balance === null || created === null) return null;
    const phone =
      item.customer_phone === null || item.customer_phone === undefined
        ? null
        : String(item.customer_phone);
    const name =
      item.customer_name === null || item.customer_name === undefined
        ? null
        : String(item.customer_name);
    const garmentCount = asInt(item.garment_count);
    rows.push(
      Object.freeze({
        order_id: item.order_id,
        ticket_no: item.ticket_no,
        status: item.status,
        customer_phone: phone,
        customer_name: name,
        payable_cents: payable,
        paid_cents: paid,
        balance_cents: balance,
        created_at: created,
        ...(garmentCount !== null ? { garment_count: garmentCount } : {}),
      }),
    );
  }
  return Object.freeze(rows);
}

export function OrdersList({
  queryClient,
  defaultDate,
  autoLoad = true,
  onOpenPickup,
}: OrdersListProps) {
  const toast = useToast();
  const [dateText, setDateText] = useState(() => defaultDate ?? localYmd());
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<readonly OrderListRowView[]>([]);
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);

  const load = useCallback(async () => {
    const body: Record<string, unknown> = { limit: 20 };
    const day = dateText.trim();
    if (day.length > 0) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) {
        toast.push("请输入日期 YYYY-MM-DD 或留空查全部", "error");
        return;
      }
      body.business_date = day;
    }
    setBusy(true);
    try {
      const res = await queryClient.execute<unknown>("order.list", body);
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        setRows([]);
        return;
      }
      const parsed = parseOrderListRows(unwrapQueryResult(res.data));
      if (parsed === null) {
        toast.push("订单列表无法解析", "error");
        setRows([]);
        return;
      }
      setRows(parsed);
    } finally {
      setBusy(false);
    }
  }, [dateText, queryClient, toast]);

  loadRef.current = load;

  useEffect(() => {
    if (!autoLoad) return;
    void loadRef.current();
  }, [autoLoad]);

  return (
    <section className="ld-orders" data-testid="orders-list-section" aria-label="近期订单">
      <h2 className="ld-orders__title">近期订单</h2>
      <p className="ld-orders__hint">按营业日筛选；点击行打开订单详情。</p>

      <div className="ld-orders-form">
        <Input
          name="orders-business-date"
          label="营业日"
          type="date"
          value={dateText}
          onChange={(event) => setDateText(event.target.value)}
          disabled={busy}
          data-testid="orders-date-input"
        />
        <div className="ld-orders-form__actions">
          <Button
            variant="primary"
            type="button"
            onClick={() => void load()}
            disabled={busy}
            data-testid="orders-load-btn"
          >
            {busy ? "加载中…" : "刷新列表"}
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setDateText("");
            }}
            disabled={busy}
            data-testid="orders-clear-date-btn"
          >
            全部日期
          </Button>
        </div>
      </div>

      <ul className="ld-orders-list" data-testid="orders-list">
        {rows.length === 0 ? (
          <li className="ld-orders-list__empty">暂无订单</li>
        ) : (
          rows.map((row) => (
            <li key={row.order_id} className="ld-orders-list__row" data-testid="orders-row">
              <button
                type="button"
                className="ld-orders-list__btn"
                onClick={() => setDetailOrderId(row.order_id)}
                data-testid="orders-row-btn"
              >
                <div className="ld-orders-list__main">
                  <span className="ld-orders-list__ticket">{row.ticket_no}</span>
                  <StatusBadge family="order" status={row.status} />
                </div>
                <div className="ld-orders-list__meta">
                  <span className="ld-orders-list__name">{row.customer_name ?? "—"}</span>
                  <span className="ld-orders-list__phone ld-orders-phone-internal">
                    {row.customer_phone ?? "—"}
                  </span>
                  {row.garment_count !== undefined ? (
                    <span className="ld-orders-list__count">{row.garment_count} 件</span>
                  ) : null}
                </div>
                <div className="ld-orders-list__money">
                  <span className="ld-orders-list__money-label">余额</span>
                  <MoneyText fen={row.balance_cents} size="sm" />
                </div>
              </button>
            </li>
          ))
        )}
      </ul>

      <OrderDetailDrawer
        open={detailOrderId !== null}
        orderId={detailOrderId}
        queryClient={queryClient}
        onClose={() => setDetailOrderId(null)}
        {...(onOpenPickup !== undefined
          ? {
              onPickup: (id: string) => {
                setDetailOrderId(null);
                onOpenPickup(id);
              },
            }
          : {})}
      />
    </section>
  );
}
