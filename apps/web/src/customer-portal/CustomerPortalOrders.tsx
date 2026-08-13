import type {
  CustomerPortalGarmentProgressResult,
  CustomerPortalGarmentsListResult,
  CustomerPortalOrderGetResult,
  CustomerPortalOrderSummary,
  CustomerPortalReceiptResult,
} from "@laundry/contracts";
import type { ReactNode } from "react";

import { customerPortalStatusLabel, formatCustomerPortalCents, progressLabels } from "./model.js";

export type CustomerPortalDetail = Readonly<{
  order: CustomerPortalOrderGetResult;
  receipt: CustomerPortalReceiptResult;
  garments: CustomerPortalGarmentsListResult;
}>;

export type CustomerPortalOrdersProps = Readonly<{
  orders: readonly CustomerPortalOrderSummary[];
  selectedOrderId: string | null;
  detail: CustomerPortalDetail | null;
  progress: Readonly<Record<string, CustomerPortalGarmentProgressResult>>;
  busy: boolean;
  error: string | null;
  account: ReactNode;
  onSelect(orderId: string): void;
  onProgress(orderId: string, garmentId: string): void;
  onRefresh(): void;
  onLogout(): void;
}>;

function OrderList(props: CustomerPortalOrdersProps) {
  return (
    <section className="ld-customer-card ld-customer-order-list" aria-labelledby="my-orders">
      <div className="ld-customer-section-heading">
        <h2 id="my-orders">我的订单</h2>
        <button type="button" className="ld-customer-link-button" onClick={props.onRefresh}>
          刷新
        </button>
      </div>
      {props.orders.length === 0 ? (
        <p className="ld-customer-muted">暂时没有可查询的正式订单。</p>
      ) : (
        <ul>
          {props.orders.map((order) => (
            <li key={order.order_id}>
              <button
                type="button"
                className={props.selectedOrderId === order.order_id ? "is-selected" : ""}
                onClick={() => props.onSelect(order.order_id)}
              >
                <span>
                  <strong>{order.ticket_no}</strong>
                  <small>{order.created_at.slice(0, 10)}</small>
                </span>
                <span>
                  <em>{customerPortalStatusLabel(order.status)}</em>
                  <small>{order.garment_count} 件</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Receipt({ detail }: Readonly<{ detail: CustomerPortalDetail }>) {
  const receipt = detail.receipt.receipt;
  return (
    <section aria-labelledby="receipt-title">
      <h3 id="receipt-title">票据</h3>
      <dl className="ld-customer-totals">
        <div>
          <dt>应付</dt>
          <dd>{formatCustomerPortalCents(receipt.payable_cents)}</dd>
        </div>
        <div>
          <dt>已付</dt>
          <dd>{formatCustomerPortalCents(receipt.paid_cents)}</dd>
        </div>
        <div>
          <dt>待付</dt>
          <dd>{formatCustomerPortalCents(receipt.balance_cents)}</dd>
        </div>
      </dl>
      <ul className="ld-customer-lines">
        {receipt.lines.map((line) => (
          <li key={line.line_index}>
            <span>
              {line.service_code} · {line.category_code} × {line.qty}
            </span>
            <strong>{formatCustomerPortalCents(line.line_total_cents)}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Garments(props: CustomerPortalOrdersProps & Readonly<{ detail: CustomerPortalDetail }>) {
  return (
    <section aria-labelledby="garments-title">
      <h3 id="garments-title">件级洗护进度</h3>
      <ul className="ld-customer-garments">
        {props.detail.garments.garments.map((garment) => {
          const progress = props.progress[garment.garment_id];
          return (
            <li key={garment.garment_id}>
              <div>
                <strong>
                  第 {garment.seq} 件 · {garment.category_code}
                </strong>
                <span className="ld-customer-status">
                  {customerPortalStatusLabel(garment.status)}
                </span>
              </div>
              <button
                type="button"
                className="ld-customer-link-button"
                onClick={() => props.onProgress(garment.order_id, garment.garment_id)}
              >
                查看节点
              </button>
              {progress === undefined ? null : (
                <ol>
                  {progressLabels(progress).map((label, index) => (
                    <li key={`${garment.garment_id}-${index}`}>{label}</li>
                  ))}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function CustomerPortalOrders(props: CustomerPortalOrdersProps) {
  return (
    <main className="ld-customer-portal">
      <header className="ld-customer-header">
        <div>
          <p className="ld-customer-eyebrow">顾客自助</p>
          <h1>我的洗护服务</h1>
        </div>
        <button type="button" onClick={props.onLogout}>
          退出
        </button>
      </header>
      {props.error === null ? null : (
        <p className="ld-customer-error" role="alert">
          {props.error}
        </p>
      )}
      {props.account}
      <div className="ld-customer-layout" aria-busy={props.busy}>
        <OrderList {...props} />
        <article className="ld-customer-card ld-customer-detail">
          {props.detail === null ? (
            <p className="ld-customer-muted">选择一个订单查看票据和每件衣物的权威进度。</p>
          ) : (
            <>
              <h2>{props.detail.order.order.ticket_no}</h2>
              <p className="ld-customer-muted">
                {customerPortalStatusLabel(props.detail.order.order.status)} · 更新于{" "}
                {props.detail.order.order.updated_at.slice(0, 16)}
              </p>
              <Receipt detail={props.detail} />
              <Garments {...props} detail={props.detail} />
            </>
          )}
        </article>
      </div>
    </main>
  );
}
