import { Button, Input } from "@laundry/ui";
import { useState } from "react";
export type OrderCenterFilter = Readonly<Record<string, unknown>>;
export const INITIAL_ORDER_FILTER: OrderCenterFilter = Object.freeze({});
export function orderViewLabel(body: OrderCenterFilter): string {
  return body.min_balance_cents === 1
    ? "欠款订单"
    : body.ready_for_pickup === true
      ? "待取订单"
      : "全部订单";
}
export function OrderCenterFilters({
  busy,
  onSearch,
}: Readonly<{
  busy: boolean;
  onSearch: (body: OrderCenterFilter) => void;
}>) {
  const [view, setView] = useState("all");
  const [ticket, setTicket] = useState("");
  const [customer, setCustomer] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="ld-order-center-filters"
      aria-label="订单筛选"
      onSubmit={(event) => {
        event.preventDefault();
        if (from && to && from > to) {
          setError("开始日期不能晚于结束日期。");
          return;
        }
        setError(null);
        onSearch({
          ...(view === "debt"
            ? { min_balance_cents: 1 }
            : view === "ready"
              ? { ready_for_pickup: true }
              : {}),
          ...(ticket.trim() ? { ticket_no: ticket.trim() } : {}),
          ...(customer.trim() ? { customer_query: customer.trim() } : {}),
          ...(from ? { date_from: from } : {}),
          ...(to ? { date_to: to } : {}),
          ...(status ? { status } : {}),
        });
      }}
    >
      <label>
        订单视图
        <select value={view} onChange={(event) => setView(event.target.value)}>
          <option value="all">全部订单</option>
          <option value="debt">欠款订单</option>
          <option value="ready">待取订单</option>
        </select>
      </label>
      <Input
        label="票号"
        value={ticket}
        maxLength={64}
        onChange={(event) => setTicket(event.target.value)}
        placeholder="完整票号"
      />
      <Input
        label="客户"
        value={customer}
        maxLength={64}
        onChange={(event) => setCustomer(event.target.value)}
        placeholder="姓名或手机号"
      />
      <Input
        label="开始营业日"
        type="date"
        value={from}
        onChange={(event) => setFrom(event.target.value)}
      />
      <Input
        label="结束营业日"
        type="date"
        value={to}
        onChange={(event) => setTo(event.target.value)}
      />
      <label>
        订单状态
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">全部状态</option>
          <option value="draft">挂单</option>
          <option value="open">进行中</option>
          <option value="closed">已完成</option>
          <option value="cancelled">已撤销</option>
        </select>
      </label>
      <Button type="submit" variant="primary" disabled={busy}>
        应用筛选
      </Button>
      {error === null ? null : <p role="alert">{error}</p>}
    </form>
  );
}
