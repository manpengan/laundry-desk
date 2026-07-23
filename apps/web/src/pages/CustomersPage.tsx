/**
 * 客户档案 — customer.search + customer.upsert + 详情/历史订单 (M2).
 */

import { Button, Input, MoneyText, StatusBadge, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { parseOrderListRows, type OrderListRowView } from "./OrdersList.js";

export type CustomerRowView = Readonly<{
  customer_id: string;
  phone: string;
  name: string | null;
  note: string | null;
  updated_at: number;
}>;

export type CustomersPageProps = {
  queryClient: QueryPort;
  commandClient: CommandPort;
  /** Skip auto-search on mount (tests). */
  autoLoad?: boolean;
  /** Prefill selected customer (SSR detail shell / tests). */
  initialSelected?: CustomerRowView;
  /** Prefill history rows for SSR when initialSelected is set. */
  initialOrders?: readonly OrderListRowView[];
  /** Navigate to pickup with order id prefilled. */
  onOpenPickup?: (orderId: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unwrap bus `{ execution, result }` or bare result. */
export function unwrapQueryResult(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if ("result" in data) return data.result;
  return data;
}

export function parseCustomerRows(value: unknown): readonly CustomerRowView[] | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.customers)) return null;
  const rows: CustomerRowView[] = [];
  for (const item of value.customers) {
    if (!isRecord(item)) return null;
    if (typeof item.customer_id !== "string") return null;
    if (typeof item.phone !== "string") return null;
    if (typeof item.updated_at !== "number" || !Number.isSafeInteger(item.updated_at)) return null;
    const name = item.name === null || item.name === undefined ? null : String(item.name);
    const note = item.note === null || item.note === undefined ? null : String(item.note);
    rows.push(
      Object.freeze({
        customer_id: item.customer_id,
        phone: item.phone,
        name,
        note,
        updated_at: item.updated_at,
      }),
    );
  }
  return Object.freeze(rows);
}

const PHONE_RE = /^1[3-9]\d{9}$/u;

/** Format unix seconds for detail shell (local, compact). */
export function formatCustomerUpdatedAt(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

export function CustomersPage({
  queryClient,
  commandClient,
  autoLoad = true,
  initialSelected,
  initialOrders,
  onOpenPickup,
}: CustomersPageProps) {
  const toast = useToast();
  const [queryText, setQueryText] = useState("");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<readonly CustomerRowView[]>([]);
  const [selected, setSelected] = useState<CustomerRowView | null>(() => initialSelected ?? null);
  const [orderRows, setOrderRows] = useState<readonly OrderListRowView[]>(
    () => initialOrders ?? Object.freeze([]),
  );
  const [ordersBusy, setOrdersBusy] = useState(false);
  const searchRef = useRef<() => Promise<void>>(async () => undefined);

  const search = useCallback(async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { limit: 20 };
      const q = queryText.trim();
      if (q.length > 0) body.query = q;
      const res = await queryClient.execute<unknown>("customer.search", body);
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        setRows([]);
        return;
      }
      const parsed = parseCustomerRows(unwrapQueryResult(res.data));
      if (parsed === null) {
        toast.push("客户列表无法解析", "error");
        setRows([]);
        return;
      }
      setRows(parsed);
    } finally {
      setBusy(false);
    }
  }, [queryClient, queryText, toast]);

  searchRef.current = search;

  useEffect(() => {
    if (!autoLoad) return;
    void searchRef.current();
  }, [autoLoad]);

  const loadOrdersForPhone = useCallback(
    async (customerPhone: string) => {
      setOrdersBusy(true);
      try {
        const res = await queryClient.execute<unknown>("order.list", {
          customer_phone: customerPhone,
          limit: 20,
        });
        if (!res.ok) {
          toast.push(res.error.message ?? res.error.code, "error");
          setOrderRows([]);
          return;
        }
        const parsed = parseOrderListRows(unwrapQueryResult(res.data));
        if (parsed === null) {
          toast.push("历史订单无法解析", "error");
          setOrderRows([]);
          return;
        }
        setOrderRows(parsed);
      } finally {
        setOrdersBusy(false);
      }
    },
    [queryClient, toast],
  );

  const selectCustomer = useCallback(
    (row: CustomerRowView) => {
      setSelected(row);
      void loadOrdersForPhone(row.phone);
    },
    [loadOrdersForPhone],
  );

  const closeDetail = useCallback(() => {
    setSelected(null);
    setOrderRows([]);
  }, []);

  const onUpsert = useCallback(async () => {
    const p = phone.trim();
    if (!PHONE_RE.test(p)) {
      toast.push("请输入 11 位手机号（1[3-9]…）", "error");
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { phone: p };
      const n = name.trim();
      if (n.length > 0) body.name = n;
      const res = await commandClient.execute<unknown>("customer.upsert", body);
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        return;
      }
      toast.push("客户已保存", "success");
      setPhone("");
      setName("");
      await search();
    } finally {
      setBusy(false);
    }
  }, [commandClient, name, phone, search, toast]);

  return (
    <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">客户</h1>
      <p className="ld-shell-main__hint">
        组织级客户档案：按手机号前缀或姓名搜索；点击行查看详情与历史订单。
      </p>

      <div className="ld-customers-search">
        <Input
          name="customer-query"
          label="搜索"
          placeholder="手机号前缀或姓名"
          value={queryText}
          onChange={(event) => setQueryText(event.target.value)}
          disabled={busy}
          data-testid="customers-search-input"
        />
        <div className="ld-customers-search__actions">
          <Button
            variant="primary"
            type="button"
            onClick={() => void search()}
            disabled={busy}
            data-testid="customers-search-btn"
          >
            {busy ? "加载中…" : "搜索"}
          </Button>
        </div>
      </div>

      <form
        className="ld-customers-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onUpsert();
        }}
      >
        <Input
          name="customer-phone"
          label="手机号"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          disabled={busy}
          data-testid="customers-phone-input"
        />
        <Input
          name="customer-name"
          label="姓名"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
          data-testid="customers-name-input"
        />
        <div className="ld-customers-form__actions">
          <Button
            variant="primary"
            type="submit"
            disabled={busy}
            data-testid="customers-upsert-btn"
          >
            保存客户
          </Button>
        </div>
      </form>

      <ul className="ld-customers-list" data-testid="customers-list">
        {rows.length === 0 ? (
          <li className="ld-customers-list__empty">暂无匹配客户</li>
        ) : (
          rows.map((row) => (
            <li key={row.customer_id} className="ld-customers-list__row">
              <button
                type="button"
                className="ld-customers-list__btn"
                onClick={() => selectCustomer(row)}
                data-testid="customers-row"
                aria-pressed={selected?.customer_id === row.customer_id}
              >
                <div className="ld-customers-list__main">
                  <span className="ld-customers-list__phone ld-customers-phone-internal">
                    {row.phone}
                  </span>
                  <span className="ld-customers-list__name">{row.name ?? "—"}</span>
                </div>
                {row.note !== null && row.note.length > 0 ? (
                  <div className="ld-customers-list__note">{row.note}</div>
                ) : null}
              </button>
            </li>
          ))
        )}
      </ul>

      {selected !== null ? (
        <section className="ld-customer-detail" data-testid="customer-detail" aria-label="客户详情">
          <div className="ld-customer-detail__head">
            <h2 className="ld-customer-detail__title">客户详情</h2>
            <Button
              variant="ghost"
              type="button"
              onClick={closeDetail}
              data-testid="customer-detail-close"
            >
              关闭
            </Button>
          </div>
          <dl className="ld-customer-detail__profile" data-testid="customer-detail-profile">
            <div className="ld-customer-detail__field">
              <dt>手机号</dt>
              <dd className="ld-customers-phone-internal">{selected.phone}</dd>
            </div>
            <div className="ld-customer-detail__field">
              <dt>姓名</dt>
              <dd>{selected.name ?? "—"}</dd>
            </div>
            <div className="ld-customer-detail__field">
              <dt>备注</dt>
              <dd>{selected.note !== null && selected.note.length > 0 ? selected.note : "—"}</dd>
            </div>
            <div className="ld-customer-detail__field">
              <dt>更新时间</dt>
              <dd data-testid="customer-detail-updated-at">
                {formatCustomerUpdatedAt(selected.updated_at)}
              </dd>
            </div>
          </dl>

          <h3 className="ld-customer-detail__orders-title">历史订单</h3>
          <p className="ld-customer-detail__orders-hint">
            {ordersBusy ? "加载中…" : `按手机号匹配，最多 20 单（最新优先）。`}
          </p>
          <ul className="ld-customer-detail__orders" data-testid="customer-detail-orders">
            {orderRows.length === 0 ? (
              <li className="ld-customer-detail__orders-empty">
                {ordersBusy ? "…" : "暂无历史订单"}
              </li>
            ) : (
              orderRows.map((order) => (
                <li key={order.order_id} className="ld-customer-detail__order-row">
                  <button
                    type="button"
                    className="ld-customer-detail__order-btn"
                    disabled={onOpenPickup === undefined}
                    onClick={() => onOpenPickup?.(order.order_id)}
                    data-testid="customer-detail-order-btn"
                  >
                    <div className="ld-customer-detail__order-main">
                      <span className="ld-customer-detail__ticket">{order.ticket_no}</span>
                      <StatusBadge family="order" status={order.status} />
                    </div>
                    <div className="ld-customer-detail__order-money">
                      <span className="ld-customer-detail__money-label">余额</span>
                      <MoneyText fen={order.balance_cents} size="sm" />
                    </div>
                  </button>
                </li>
              ))
            )}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
