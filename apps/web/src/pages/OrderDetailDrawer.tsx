/**
 * Workbench order detail drawer — loads order.get when open + orderId.
 */

import { Button, Drawer, MoneyText, StatusBadge, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryPort } from "../commands/types.js";
import {
  parseOrderGetResult,
  unwrapCommandResult,
  type OrderGetGarment,
  type OrderGetResult,
} from "./order-form.js";

export type OrderDetailDrawerProps = {
  open: boolean;
  orderId: string | null;
  queryClient: QueryPort;
  onClose: () => void;
  /** Navigate to pickup with this order id. */
  onPickup?: (orderId: string) => void;
};

export type OrderDetailLoadState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; message: string }>
  | Readonly<{ status: "ready"; order: OrderGetResult }>;

export function OrderDetailDrawer({
  open,
  orderId,
  queryClient,
  onClose,
  onPickup,
}: OrderDetailDrawerProps) {
  const toast = useToast();
  const [load, setLoad] = useState<OrderDetailLoadState>({ status: "idle" });
  const requestRef = useRef(0);

  const loadOrder = useCallback(
    async (id: string) => {
      const req = ++requestRef.current;
      setLoad({ status: "loading" });
      try {
        const res = await queryClient.execute<unknown>("order.get", { order_id: id });
        if (req !== requestRef.current) return;
        if (!res.ok) {
          setLoad({
            status: "error",
            message: res.error.message ?? res.error.code,
          });
          return;
        }
        const parsed = parseOrderGetResult(unwrapCommandResult(res.data));
        if (parsed === null) {
          setLoad({ status: "error", message: "订单详情无法解析" });
          return;
        }
        setLoad({ status: "ready", order: parsed });
      } catch {
        if (req !== requestRef.current) return;
        setLoad({ status: "error", message: "加载订单失败" });
      }
    },
    [queryClient],
  );

  useEffect(() => {
    if (!open || orderId === null || orderId.length === 0) {
      setLoad({ status: "idle" });
      return;
    }
    void loadOrder(orderId);
  }, [open, orderId, loadOrder]);

  const title = load.status === "ready" ? `订单 ${load.order.ticket_no}` : "订单详情";

  const handlePickup = useCallback(() => {
    if (orderId === null || orderId.length === 0) return;
    if (onPickup === undefined) {
      toast.push("取衣入口不可用", "error");
      return;
    }
    onPickup(orderId);
  }, [onPickup, orderId, toast]);

  return (
    <Drawer open={open} title={title} onClose={onClose} className="ld-order-detail-drawer">
      <div className="ld-order-detail" data-testid="order-detail-drawer">
        {load.status === "idle" || load.status === "loading" ? (
          <p className="ld-order-detail__status" data-testid="order-detail-loading">
            {load.status === "loading" ? "加载中…" : "选择订单查看详情"}
          </p>
        ) : null}

        {load.status === "error" ? (
          <p className="ld-order-detail__error" data-testid="order-detail-error" role="alert">
            {load.message}
          </p>
        ) : null}

        {load.status === "ready" ? <OrderDetailContent order={load.order} /> : null}

        <div className="ld-order-detail__actions">
          {onPickup !== undefined ? (
            <Button
              variant="primary"
              type="button"
              onClick={handlePickup}
              disabled={orderId === null || orderId.length === 0}
              data-testid="order-detail-pickup-btn"
            >
              去取衣
            </Button>
          ) : null}
          <Button
            variant="ghost"
            type="button"
            onClick={onClose}
            data-testid="order-detail-close-btn"
          >
            关闭
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

/** Pure detail body (exported for SSR tests with seeded order.get payload). */
export function OrderDetailContent({ order }: { order: OrderGetResult }) {
  return (
    <>
      <section className="ld-order-detail__summary" aria-label="订单摘要">
        <dl className="ld-order-detail__meta">
          <div>
            <dt>票号</dt>
            <dd data-testid="order-detail-ticket">{order.ticket_no}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd data-testid="order-detail-status">
              <StatusBadge family="order" status={order.status} />
            </dd>
          </div>
          <div>
            <dt>客户</dt>
            <dd data-testid="order-detail-name">{order.customer_name ?? "—"}</dd>
          </div>
          <div>
            <dt>手机</dt>
            <dd
              className="ld-order-detail__phone ld-orders-phone-internal"
              data-testid="order-detail-phone"
            >
              {order.customer_phone ?? "—"}
            </dd>
          </div>
          <div>
            <dt>应付</dt>
            <dd data-testid="order-detail-payable">
              <MoneyText fen={order.payable_cents} />
            </dd>
          </div>
          <div>
            <dt>已付</dt>
            <dd data-testid="order-detail-paid">
              <MoneyText fen={order.paid_cents} />
            </dd>
          </div>
          <div>
            <dt>余额</dt>
            <dd data-testid="order-detail-balance">
              <MoneyText fen={order.balance_cents} />
            </dd>
          </div>
        </dl>
      </section>

      <section className="ld-order-detail__photos" aria-label="照片">
        <h3 className="ld-order-detail__section-title">照片</h3>
        <div className="ld-order-detail__photo-strip" data-testid="order-detail-photos">
          <p className="ld-order-detail__photo-empty">照片 M3</p>
        </div>
      </section>

      <section className="ld-order-detail__garments" aria-label="衣物列表">
        <h3 className="ld-order-detail__section-title">衣物</h3>
        {order.garments.length === 0 ? (
          <p className="ld-order-detail__empty">暂无衣物</p>
        ) : (
          <ul className="ld-order-detail__garment-list" data-testid="order-detail-garments">
            {order.garments.map((g) => (
              <GarmentRow key={g.garment_id} garment={g} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function GarmentRow({ garment }: { garment: OrderGetGarment }) {
  return (
    <li className="ld-order-detail__garment" data-testid="order-detail-garment">
      <span className="ld-order-detail__barcode">{garment.barcode}</span>
      <StatusBadge family="garment" status={garment.status} />
      <MoneyText fen={garment.unit_price_cents} size="sm" />
    </li>
  );
}
