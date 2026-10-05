import { Button, MoneyText, StatusBadge } from "@laundry/ui";

import { printJobStatusLabel, type PrintJobView } from "../shell/print-jobs.js";
import { formatCustomerUpdatedAt, type CustomerRowView } from "./customer-model.js";
import { OrderPagination } from "./OrderPagination.js";
import { ListLoadNotice } from "./ListLoadNotice.js";
import type { OrderListRowView } from "./OrdersList.js";

export type CustomerDetailProps = Readonly<{
  customer: CustomerRowView;
  orders: readonly OrderListRowView[];
  printJobs: readonly PrintJobView[] | null;
  busy: boolean;
  onClose: () => void;
  showClose?: boolean;
  onOpenOrder: (orderId: string) => void;
  ordersPage?: Readonly<{ total: number; offset: number; limit: number }>;
  ordersError?: string | null;
  onOrdersPage?: (offset: number) => void;
  onOrdersRetry?: () => void;
  onOpenPickup?: (orderId: string) => void;
}>;

function PrintReferences({
  orderId,
  printJobs,
}: Readonly<{ orderId: string; printJobs: readonly PrintJobView[] | null }>) {
  if (printJobs === null) {
    return <span className="ld-customer-detail__print">打印状态暂不可用</span>;
  }
  const jobs = printJobs.filter((job) => job.order_id === orderId);
  return (
    <span className="ld-customer-detail__print">
      {jobs.length === 0
        ? "暂无打印记录"
        : `打印：${jobs.map((job) => printJobStatusLabel(job.status)).join("、")}`}
    </span>
  );
}

export function CustomerDetail({
  customer,
  orders,
  printJobs,
  busy,
  onClose,
  showClose = true,
  onOpenOrder,
  onOpenPickup,
  ordersPage,
  ordersError = null,
  onOrdersPage,
  onOrdersRetry,
}: CustomerDetailProps) {
  return (
    <section className="ld-customer-detail" data-testid="customer-detail" aria-label="客户详情">
      <div className="ld-customer-detail__head">
        <h2 className="ld-customer-detail__title">客户详情</h2>
        {showClose ? (
          <Button
            variant="ghost"
            type="button"
            onClick={onClose}
            data-testid="customer-detail-close"
          >
            关闭
          </Button>
        ) : null}
      </div>
      <dl className="ld-customer-detail__profile" data-testid="customer-detail-profile">
        <div className="ld-customer-detail__field">
          <dt>手机号</dt>
          <dd className="ld-customers-phone-internal">{customer.phone}</dd>
        </div>
        <div className="ld-customer-detail__field">
          <dt>姓名</dt>
          <dd>{customer.name ?? "—"}</dd>
        </div>
        <div className="ld-customer-detail__field">
          <dt>备注</dt>
          <dd>{customer.note !== null && customer.note.length > 0 ? customer.note : "—"}</dd>
        </div>
        <div className="ld-customer-detail__field">
          <dt>更新时间</dt>
          <dd data-testid="customer-detail-updated-at">
            {formatCustomerUpdatedAt(customer.updated_at)}
          </dd>
        </div>
      </dl>

      <h3 className="ld-customer-detail__orders-title">历史订单</h3>
      <p className="ld-customer-detail__orders-hint">
        {busy ? "加载中…" : "全部历史按页显示，可查看欠款、照片与最近打印状态。"}
      </p>
      <ListLoadNotice
        error={ordersError}
        loaded={orders.length > 0}
        busy={busy}
        onRetry={onOrdersRetry ?? (() => undefined)}
        testId="customer-history-error"
      />
      {ordersPage === undefined || onOrdersPage === undefined ? null : (
        <OrderPagination {...ordersPage} busy={busy} onPage={onOrdersPage} />
      )}
      <ul className="ld-customer-detail__orders" data-testid="customer-detail-orders">
        {orders.length === 0 ? (
          <li className="ld-customer-detail__orders-empty">
            {ordersError !== null
              ? "历史订单未能更新"
              : busy
                ? "…"
                : (ordersPage?.total ?? 0) > 0
                  ? "当前页已无订单，请返回上一页。"
                  : "暂无历史订单"}
          </li>
        ) : (
          orders.map((order) => (
            <li key={order.order_id} className="ld-customer-detail__order-row">
              <div className="ld-customer-detail__order-btn">
                <button
                  type="button"
                  className="ld-customer-detail__order-link"
                  onClick={() => onOpenOrder(order.order_id)}
                  data-testid="customer-detail-order-btn"
                >
                  <span className="ld-customer-detail__ticket">{order.ticket_no ?? "挂单"}</span>
                  <StatusBadge family="order" status={order.status} />
                </button>
                <div className="ld-customer-detail__order-money">
                  <span className="ld-customer-detail__money-label">余额</span>
                  <MoneyText fen={order.balance_cents} size="sm" />
                </div>
                <PrintReferences orderId={order.order_id} printJobs={printJobs} />
                {onOpenPickup !== undefined && order.status === "open" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => onOpenPickup(order.order_id)}
                  >
                    去取衣
                  </Button>
                ) : null}
              </div>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
