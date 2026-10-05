/**
 * Workbench order detail drawer — loads order.get + photo.list_by_order when open.
 * Photo section uses the named PhotoPort; transport credentials stay outside React.
 */

import { Drawer } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { PhotoPort } from "../host/photo-port.js";
import { OrderDetailActions } from "./OrderDetailActions.js";
import { OrderDetailContent } from "./OrderDetailContent.js";
import { PaymentLedgerPanel } from "./PaymentLedgerPanel.js";
import { MemberOrderBenefitsPanel } from "./MemberOrderBenefitsPanel.js";
import { OrderPhotoWorkspace } from "./OrderPhotoWorkspace.js";
import { parseOrderGetResult, unwrapCommandResult, type OrderGetResult } from "./order-form.js";

export { OrderDetailContent, type OrderDetailContentProps } from "./OrderDetailContent.js";
export { parsePhotoList, unwrapPhotoResult, type PhotoMetaRow } from "./photo-list.js";

export type OrderDetailDrawerProps = {
  open: boolean;
  orderId: string | null;
  queryClient: QueryPort;
  commandClient?: CommandPort;
  authClient?: AuthClient;
  session?: SessionView;
  photoPort?: PhotoPort;
  /** UI feature mirror only; server remains authoritative. */
  memberEnabled?: boolean;
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
  commandClient,
  authClient,
  session,
  photoPort,
  memberEnabled = false,
  onClose,
  onPickup,
}: OrderDetailDrawerProps) {
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
      requestRef.current += 1;
      setLoad({ status: "idle" });
      return;
    }
    void loadOrder(orderId);
    return () => {
      requestRef.current += 1;
    };
  }, [open, orderId, loadOrder]);

  const title = load.status === "ready" ? `订单 ${load.order.ticket_no ?? "挂单"}` : "订单详情";

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

        {open && load.status === "ready" && load.order.order_id === orderId ? (
          <OrderDetailContent
            order={load.order}
            photoSection={
              <OrderPhotoWorkspace
                order={load.order}
                queryClient={queryClient}
                {...(photoPort === undefined ? {} : { photoPort })}
              />
            }
          />
        ) : null}
        {load.status === "ready" ? (
          <PaymentLedgerPanel
            orderId={load.order.order_id}
            queryClient={queryClient}
            onCompleted={() => loadOrder(load.order.order_id)}
            {...(commandClient === undefined ? {} : { commandClient })}
            {...(authClient === undefined ? {} : { authClient })}
            {...(session === undefined ? {} : { session })}
          />
        ) : null}
        {load.status === "ready" && memberEnabled && commandClient !== undefined ? (
          <MemberOrderBenefitsPanel
            order={load.order}
            queryClient={queryClient}
            commandClient={commandClient}
            onOrderReload={() => loadOrder(load.order.order_id)}
          />
        ) : null}
        <OrderDetailActions
          orderId={orderId}
          order={load.status === "ready" ? load.order : null}
          queryClient={queryClient}
          memberEnabled={memberEnabled}
          onClose={onClose}
          onReload={loadOrder}
          {...(commandClient === undefined ? {} : { commandClient })}
          {...(onPickup === undefined ? {} : { onPickup })}
        />
      </div>
    </Drawer>
  );
}
