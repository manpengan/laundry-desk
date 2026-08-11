import { Button, useToast } from "@laundry/ui";
import { useCallback, useState } from "react";

import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { DangerConfirmDialog } from "./DangerConfirmDialog.js";
import { PaymentCollectionDialog } from "./PaymentCollectionDialog.js";
import type { OrderGetResult } from "./order-form.js";

type CancelState =
  Readonly<{ status: "idle" }> | Readonly<{ status: "server_confirmation"; confirmRef: string }>;

export type OrderDetailActionsProps = Readonly<{
  orderId: string | null;
  order: OrderGetResult | null;
  queryClient: QueryPort;
  commandClient?: CommandPort;
  memberEnabled: boolean;
  onClose: () => void;
  onPickup?: (orderId: string) => void;
  onReload: (orderId: string) => void | Promise<void>;
}>;

export function OrderDetailActions({
  orderId,
  order,
  queryClient,
  commandClient,
  memberEnabled,
  onClose,
  onPickup,
  onReload,
}: OrderDetailActionsProps) {
  const toast = useToast();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelState, setCancelState] = useState<CancelState>({ status: "idle" });
  const [paymentOpen, setPaymentOpen] = useState(false);

  const handlePickup = useCallback(() => {
    if (orderId === null || orderId.length === 0) return;
    if (onPickup === undefined) {
      toast.push("取衣入口不可用", "error");
      return;
    }
    onPickup(orderId);
  }, [onPickup, orderId, toast]);

  const closeCancel = useCallback(() => {
    if (cancelBusy) return;
    setCancelOpen(false);
    setCancelState({ status: "idle" });
  }, [cancelBusy]);

  const handleCancel = useCallback(
    async (reason: string) => {
      if (commandClient === undefined || orderId === null || order === null) return;
      setCancelBusy(true);
      try {
        const result =
          cancelState.status === "server_confirmation"
            ? await commandClient.execute(
                "order.cancel",
                {},
                { confirmRef: cancelState.confirmRef },
              )
            : await commandClient.execute("order.cancel", { order_id: orderId, reason });
        if (result.ok) {
          toast.push("订单已撤销，相关流水已按规则反向记账", "success");
          setCancelOpen(false);
          setCancelState({ status: "idle" });
          await onReload(orderId);
          return;
        }
        if (cancelState.status === "idle" && isStepUpRequired(result)) {
          if (result.error.code !== "POLICY_CONFIRMATION_REQUIRED") {
            toast.push("此撤销需要主管二次授权，请由主管在授权入口完成", "error");
            return;
          }
          setCancelState({
            status: "server_confirmation",
            confirmRef: result.error.detail.confirm_ref,
          });
          toast.push("服务端要求再次确认", "info");
          return;
        }
        toast.push(result.error.message ?? result.error.code, "error");
      } finally {
        setCancelBusy(false);
      }
    },
    [cancelState, commandClient, onReload, order, orderId, toast],
  );

  return (
    <>
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
        {commandClient !== undefined &&
        order !== null &&
        order.status === "open" &&
        order.balance_cents > 0 ? (
          <Button
            variant="secondary"
            type="button"
            onClick={() => setPaymentOpen(true)}
            data-testid="order-detail-payment-btn"
          >
            补缴 / 收款
          </Button>
        ) : null}
        {commandClient !== undefined && order !== null && order.status === "open" ? (
          <Button
            variant="danger"
            type="button"
            onClick={() => setCancelOpen(true)}
            disabled={cancelBusy}
            data-testid="order-detail-cancel-btn"
          >
            撤销订单
          </Button>
        ) : null}
      </div>
      <DangerConfirmDialog
        open={cancelOpen}
        title="撤销订单"
        description="撤销会关闭订单，并按服务端规则生成可审计的反向流水。此操作不能撤回。"
        confirmLabel={cancelState.status === "server_confirmation" ? "再次确认撤销" : "确认撤销"}
        busy={cancelBusy}
        serverConfirmation={cancelState.status === "server_confirmation"}
        onClose={closeCancel}
        onConfirm={(reason) => void handleCancel(reason)}
      />
      {commandClient !== undefined && order !== null ? (
        <PaymentCollectionDialog
          open={paymentOpen}
          order={order}
          commandClient={commandClient}
          queryClient={queryClient}
          memberEnabled={memberEnabled}
          onClose={() => setPaymentOpen(false)}
          onCompleted={() => {
            if (orderId !== null) void onReload(orderId);
          }}
        />
      ) : null}
    </>
  );
}
