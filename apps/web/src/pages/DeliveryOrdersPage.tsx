import { Button, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { DangerConfirmDialog } from "./DangerConfirmDialog.js";
import {
  DeliveryOrderDetailPanel,
  DeliveryOrderPendingSummary,
} from "./DeliveryOrderDetailPanel.js";
import { DeliveryOrderWorklist } from "./DeliveryOrderWorklist.js";
import {
  buildDeliveryOrderListInput,
  buildDeliveryOrderTransition,
  DELIVERY_ORDER_STATUS_LABELS,
  nextDeliveryOrderStatuses,
  parseDeliveryOrder,
  parseDeliveryOrderMutation,
  parseDeliveryOrders,
  type DeliveryOrderPendingTransition,
  type DeliveryOrderView,
} from "./delivery-order-model.js";
import {
  createDeliveryOrderRequestAuthority,
  createDeliveryOrderStepUpCloseGate,
  deliveryOrderDetailAuthorityKey,
  deliveryOrderListAuthorityKey,
  deliveryOrderSessionScope,
  deliveryOrderTransitionAuthorityKey,
  deliveryOrderTransitionStillMatches,
} from "./delivery-order-request-authority.js";
import type { DeliveryOrderCancellationReason, DeliveryOrderStatus } from "@laundry/contracts";

export type DeliveryOrdersPageProps = Readonly<{
  queryClient: QueryPort;
  commandClient: CommandPort;
  authClient: AuthClient;
  session: SessionView;
}>;

export function DeliveryOrdersPage({
  queryClient,
  commandClient,
  authClient,
  session,
}: DeliveryOrdersPageProps) {
  const toast = useToast();
  const [orders, setOrders] = useState<readonly DeliveryOrderView[]>([]);
  const [status, setStatus] = useState<DeliveryOrderStatus | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DeliveryOrderView | null>(null);
  const [cancellationReason, setCancellationReason] =
    useState<DeliveryOrderCancellationReason>("customer_request");
  const [pending, setPending] = useState<DeliveryOrderPendingTransition | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const sessionScope = deliveryOrderSessionScope(session);
  const [dataScope, setDataScope] = useState(sessionScope);
  const authorityRef = useRef(createDeliveryOrderRequestAuthority(sessionScope));
  const stepUpCloseGateRef = useRef(createDeliveryOrderStepUpCloseGate());
  if (authorityRef.current.scope !== sessionScope) {
    authorityRef.current = createDeliveryOrderRequestAuthority(sessionScope);
  }

  const loadDetail = useCallback(
    async (deliveryOrderId: string) => {
      authorityRef.current.invalidate("transition");
      setPending(null);
      setSelectedId(deliveryOrderId);
      setDetail(null);
      const token = authorityRef.current.begin(
        "detail",
        deliveryOrderDetailAuthorityKey(sessionScope, deliveryOrderId),
      );
      try {
        const result = await queryClient.execute<unknown>("delivery.order.get", {
          delivery_order_id: deliveryOrderId,
        });
        if (!authorityRef.current.isCurrent(token)) return;
        if (!result.ok) {
          toast.push(result.error.message ?? result.error.code, "error");
          setDetail(null);
          return;
        }
        const parsed = parseDeliveryOrder(result.data);
        if (parsed === null || parsed.delivery_order_id !== deliveryOrderId) {
          toast.push("取送订单详情响应无法解析", "error");
          setDetail(null);
          return;
        }
        setDetail(parsed);
        setSelectedId(parsed.delivery_order_id);
      } catch {
        if (!authorityRef.current.isCurrent(token)) return;
        setDetail(null);
        toast.push("取送订单详情读取失败，请检查服务连接", "error");
      }
    },
    [queryClient, sessionScope, toast],
  );

  const loadList = useCallback(async () => {
    const input = buildDeliveryOrderListInput(status === "all" ? null : status);
    if (input === null) return;
    const token = authorityRef.current.begin(
      "list",
      deliveryOrderListAuthorityKey(sessionScope, status),
    );
    setBusy(true);
    try {
      const result = await queryClient.execute<unknown>("delivery.orders.list", input);
      if (!authorityRef.current.isCurrent(token)) return;
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        setLoaded(false);
        return;
      }
      const parsed = parseDeliveryOrders(result.data);
      if (parsed === null) {
        toast.push("取送订单列表响应无法解析", "error");
        setLoaded(false);
        return;
      }
      setOrders(parsed);
      setLoaded(true);
    } catch {
      if (!authorityRef.current.isCurrent(token)) return;
      setLoaded(false);
      toast.push("取送订单读取失败，请检查服务连接", "error");
    } finally {
      if (authorityRef.current.isCurrent(token)) setBusy(false);
    }
  }, [queryClient, sessionScope, status, toast]);

  useEffect(() => {
    authorityRef.current.invalidateAll();
    setOrders([]);
    setSelectedId(null);
    setDetail(null);
    setPending(null);
    setLoaded(false);
    setBusy(false);
    stepUpCloseGateRef.current.reset();
    setDataScope(sessionScope);
  }, [sessionScope]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const refreshAfterMutation = useCallback(
    async (updated: DeliveryOrderView) => {
      setDetail(updated);
      setSelectedId(updated.delivery_order_id);
      await loadList();
    },
    [loadList],
  );

  const resume = useCallback(async () => {
    if (pending === null) return;
    if (
      pending.authorityKey !== deliveryOrderTransitionAuthorityKey(sessionScope, pending.body) ||
      !deliveryOrderTransitionStillMatches(pending.body, detail, cancellationReason)
    ) {
      authorityRef.current.invalidate("transition");
      setPending(null);
      toast.push("订单或确认内容已变化，请按最新资料重新发起", "error");
      return;
    }
    const token = authorityRef.current.begin("transition", pending.authorityKey);
    setBusy(true);
    try {
      const result = await commandClient.execute<unknown>(
        "delivery.order.transition",
        {},
        { confirmRef: pending.confirmRef },
      );
      if (!authorityRef.current.isCurrent(token)) return;
      setPending(null);
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        setBusy(false);
        await loadList();
        await loadDetail(pending.body.delivery_order_id);
        return;
      }
      const updated = parseDeliveryOrderMutation(result.data);
      if (updated === null) {
        toast.push("取送订单转换响应无法解析", "error");
        return;
      }
      toast.push(`${pending.label}完成`, "success");
      await refreshAfterMutation(updated);
    } catch {
      if (!authorityRef.current.isCurrent(token)) return;
      toast.push(`${pending.label}失败，请刷新确认`, "error");
    } finally {
      if (authorityRef.current.isCurrent(token)) setBusy(false);
    }
  }, [
    cancellationReason,
    commandClient,
    detail,
    loadDetail,
    loadList,
    pending,
    refreshAfterMutation,
    sessionScope,
    toast,
  ]);

  const transition = useCallback(
    async (targetStatus: DeliveryOrderStatus) => {
      if (detail === null) return;
      const body = buildDeliveryOrderTransition(detail, targetStatus, cancellationReason);
      if (body === null) {
        toast.push("当前状态不能执行该转换，请重新读取", "error");
        return;
      }
      const label = DELIVERY_ORDER_STATUS_LABELS[targetStatus];
      const authorityKey = deliveryOrderTransitionAuthorityKey(sessionScope, body);
      const token = authorityRef.current.begin("transition", authorityKey);
      setPending(null);
      setBusy(true);
      try {
        const result = await commandClient.execute<unknown>("delivery.order.transition", body);
        if (!authorityRef.current.isCurrent(token)) return;
        if (result.ok) {
          const updated = parseDeliveryOrderMutation(result.data);
          if (updated === null) {
            toast.push("取送订单转换响应无法解析", "error");
            return;
          }
          toast.push(`${label}完成`, "success");
          await refreshAfterMutation(updated);
          return;
        }
        if (isStepUpRequired(result)) {
          stepUpCloseGateRef.current.reset();
          setPending(
            Object.freeze({
              body,
              authorityKey,
              confirmRef: result.error.detail.confirm_ref,
              kind: result.error.code === "POLICY_STEP_UP_REQUIRED" ? "step_up" : "confirm",
              label,
              summary: Object.freeze({
                deliveryOrderId: detail.delivery_order_id,
                laundryOrderId: detail.laundry_order_id,
                currentStatus: detail.status,
                collectionMethod: detail.collection_method,
                returnMethod: detail.return_method,
                cancellationReason: targetStatus === "cancelled" ? cancellationReason : null,
              }),
            }),
          );
          return;
        }
        toast.push(
          result.error.code === "INVARIANT_FAILED"
            ? "订单版本、路线或洗护状态已变化，请按最新资料重试"
            : (result.error.message ?? result.error.code),
          "error",
        );
        setBusy(false);
        await loadList();
        await loadDetail(detail.delivery_order_id);
      } catch {
        if (!authorityRef.current.isCurrent(token)) return;
        toast.push(`${label}失败，请刷新确认`, "error");
      } finally {
        if (authorityRef.current.isCurrent(token)) setBusy(false);
      }
    },
    [
      cancellationReason,
      commandClient,
      detail,
      loadDetail,
      loadList,
      refreshAfterMutation,
      sessionScope,
      toast,
    ],
  );

  const scopeIsCurrent = dataScope === sessionScope;
  const visibleDetail = scopeIsCurrent ? detail : null;
  const visiblePending = scopeIsCurrent ? pending : null;
  const nextStatuses =
    visibleDetail === null ? Object.freeze([]) : nextDeliveryOrderStatuses(visibleDetail);
  const featureEnabled = session.features.delivery_enabled === true;
  const closePending = () => {
    stepUpCloseGateRef.current.reset();
    authorityRef.current.invalidate("transition");
    setPending(null);
  };
  const closeApprovedStepUp = () => {
    if (stepUpCloseGateRef.current.consumeClose()) {
      closePending();
      return;
    }
    setPending(null);
  };

  return (
    <main className="ld-shell-main ld-delivery-orders lg-card" id="main-content" tabIndex={-1}>
      <header className="ld-delivery-orders__header">
        <div>
          <h1 className="ld-shell-main__title">取送订单</h1>
          <p className="ld-shell-main__hint">
            预约、配送订单、任务和交付证据彼此独立；本页只推进权威配送订单状态。
          </p>
        </div>
        <Button variant="ghost" type="button" disabled={busy} onClick={() => void loadList()}>
          重新读取
        </Button>
      </header>

      {!featureEnabled ? (
        <p className="ld-delivery-orders__notice" role="status">
          门店取送功能已关闭：不能创建新单，既有在途订单仍可查询、推进或取消。
        </p>
      ) : null}

      <div className="ld-delivery-orders__layout">
        <DeliveryOrderWorklist
          orders={scopeIsCurrent ? orders : []}
          status={status}
          selectedId={scopeIsCurrent ? selectedId : null}
          busy={busy}
          loaded={scopeIsCurrent && loaded}
          onStatusChange={(value) => {
            authorityRef.current.invalidate("list");
            setStatus(value);
            setLoaded(false);
          }}
          onSelect={(value) => void loadDetail(value)}
        />

        <DeliveryOrderDetailPanel
          detail={visibleDetail}
          nextStatuses={nextStatuses}
          cancellationReason={cancellationReason}
          busy={busy}
          onCancellationReasonChange={(value) => {
            authorityRef.current.invalidate("transition");
            setPending(null);
            setCancellationReason(value);
          }}
          onTransition={(value) => void transition(value)}
        />
      </div>

      <DangerConfirmDialog
        open={visiblePending?.kind === "confirm"}
        title="确认推进取送订单"
        description="服务端已冻结订单、当前版本和目标状态；继续后将提交一次 CAS 转换。"
        summary={
          visiblePending === null ? undefined : (
            <DeliveryOrderPendingSummary pending={visiblePending} />
          )
        }
        confirmLabel="确认执行"
        serverConfirmation
        busy={busy}
        onClose={closePending}
        onConfirm={() => void resume()}
      />
      {visiblePending?.kind === "step_up" ? (
        <StepUpConfirmDialog
          open
          onClose={closeApprovedStepUp}
          authClient={authClient}
          confirmRef={visiblePending.confirmRef}
          currentStaffId={session.session.staff_id}
          commandLabel={visiblePending.label}
          summary={<DeliveryOrderPendingSummary pending={visiblePending} />}
          onApproved={() => {
            stepUpCloseGateRef.current.markApproved();
            void resume();
          }}
        />
      ) : null}
    </main>
  );
}
