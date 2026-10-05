import type { TicketPreview } from "@laundry/domain";
import { Button, useToast } from "@laundry/ui";
import { useCallback, useMemo, useRef } from "react";

import type { PaymentChannelPort } from "../host/payment-channel-port.js";
import type { PhotoPort } from "../host/photo-port.js";
import type { ScalePort } from "../host/scale-port.js";
import type { StaffRole } from "../auth/permissions.js";
import type { CatalogListItem } from "../commands/query-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { CatalogPicker } from "./CatalogPicker.js";
import { recoverDraftForm } from "./draft-recovery.js";

import { applyCatalogPick, ReceiveLineEditor } from "./ReceiveLineEditor.js";
import { ReceiveProgressPanel } from "./ReceiveProgressPanel.js";
import { ReceiveDraftPanel } from "./ReceiveDraftPanel.js";
import { ReceiveCompletedWorkspace } from "./ReceiveCompletedWorkspace.js";
import { ReceiveCheckoutShortcut } from "./ReceiveCheckoutShortcut.js";
import {
  buildReceiveBody,
  parseHoldDraftId,
  parseOrderGetResult,
  unwrapCommandResult,
} from "./order-form.js";
import { activePricingAddons } from "./pricing-policy-model.js";
import { previewReceiveTotals } from "./receive-pricing-selection.js";
import { ReceiveSettlementPanel } from "./ReceiveSettlementPanel.js";
import {
  buildReceiveTicketPreview,
  formatReceiveDateLabel,
  type TicketPreviewLineDraft,
} from "./ticket-preview.js";
import { notifyReceiveSuccess } from "./ticket-print-enqueue.js";
import { useReceiveKeyboard } from "./use-receive-keyboard.js";
import { useReceiveResources } from "./use-receive-resources.js";
import { useReceiveForm } from "./use-receive-form.js";
import { submitReceive } from "./receive-submission.js";
import { useScanFocus } from "./use-scan-focus.js";

export { enqueueTicketPrint, notifyReceiveSuccess } from "./ticket-print-enqueue.js";

export type ReceivePageProps = {
  commandClient: CommandPort;
  queryClient?: QueryPort;
  storeName?: string;
  storePhone?: string;
  onTicketReady?: (preview: TicketPreview) => void;
  /** Only the packaged desktop host has a local signed-print queue. */
  queuePrintEnabled?: boolean;
  role?: StaffRole;
  scalePort?: ScalePort;
  paymentChannelPort?: PaymentChannelPort;
  photoPort?: PhotoPort;
};

export function ReceivePage({
  commandClient,
  queryClient,
  storeName = "洗衣店",
  storePhone,
  onTicketReady,
  queuePrintEnabled = false,
  role,
  scalePort,
  paymentChannelPort,
  photoPort,
}: ReceivePageProps) {
  const toast = useToast();
  const {
    store,
    confirmDiscard,
    phone,
    name,
    paymentCents,
    paymentMethod,
    pricing,
    note,
    draftId,
    lines,
    focusedLineKey,
    busy: submitting,
    recoveryStatus,
    recoveryMessage,
    phase,
    setPhone,
    setName,
    setPaymentCents,
    setPaymentMethod,
    setPricing,
    setNote,
    setDraftId,
    setLines,
    setFocusedLineKey,
    setBusy,
    setResult,
    setTicketPreview,
  } = useReceiveForm();
  const busy = submitting || recoveryStatus === "loading";
  const { policy, policyReady, draftRows, draftLoading, reloadDrafts } =
    useReceiveResources(queryClient);
  const totals = useMemo(
    () => previewReceiveTotals(lines, pricing, policy),
    [lines, policy, pricing],
  );
  const canDiscount = role === "admin";
  const pageRef = useRef<HTMLElement | null>(null);
  useScanFocus(pageRef, 'input[name="customer-phone"]', phase === "editing");

  const onPickCatalog = useCallback(
    (item: CatalogListItem) => {
      if (store.getSnapshot().busy || store.getSnapshot().phase !== "editing") return;
      const current = store.getSnapshot();
      const applied = applyCatalogPick(current.lines, current.focusedLineKey, item);
      store.patch({ lines: applied.lines, focusedLineKey: applied.focusedKey, dirty: true });
    },
    [store],
  );

  const build = useCallback(
    (includePayment: boolean) =>
      buildReceiveBody({
        customer_phone: phone,
        customer_name: name,
        initial_payment_cents: includePayment ? paymentCents : "0",
        initial_payment_method: paymentMethod,
        discount_cents: canDiscount ? pricing.discount_cents : "0",
        urgent: pricing.urgent,
        freight: pricing.freight,
        note,
        lines,
        ...(draftId === null ? {} : { draft_id: draftId }),
      }),
    [canDiscount, draftId, lines, name, note, paymentCents, paymentMethod, phone, pricing],
  );

  const onHold = useCallback(async () => {
    if (store.getSnapshot().busy || store.getSnapshot().phase !== "editing") return;
    const built = build(false);
    if (!built.ok) {
      toast.push(built.message, "error");
      return;
    }
    setBusy(true);
    try {
      const res = await commandClient.execute<unknown>("order.hold", built.body);
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        return;
      }
      const receivedDraftId = parseHoldDraftId(unwrapCommandResult(res.data));
      if (receivedDraftId === null) {
        toast.push("暂存成功但挂单标识无法解析", "error");
        return;
      }
      store.patch({ draftId: receivedDraftId, dirty: paymentCents !== "0" });
      await reloadDrafts();
      toast.push("已暂存挂单；确认开单后才会生成票号与收款", "success");
    } catch {
      toast.push("无法暂存挂单，请检查服务连接", "error");
    } finally {
      setBusy(false);
    }
  }, [build, commandClient, reloadDrafts, toast, store, paymentCents, setBusy]);

  const onResumeDraft = useCallback(
    async (orderId: string) => {
      if (queryClient === undefined || store.getSnapshot().busy) return;
      if (
        store.getSnapshot().dirty &&
        !(await confirmDiscard("恢复挂单将替换当前录入。需要保留时，请先返回暂存。"))
      )
        return;
      if (store.getSnapshot().busy || store.getSnapshot().phase !== "editing") return;
      setBusy(true);
      try {
        const response = await queryClient.execute<unknown>("order.get", { order_id: orderId });
        if (!response.ok) {
          toast.push(response.error.message ?? response.error.code, "error");
          await reloadDrafts();
          return;
        }
        const order = parseOrderGetResult(unwrapCommandResult(response.data));
        if (order === null) {
          toast.push("挂单详情返回格式无效", "error");
          return;
        }
        const recovered = recoverDraftForm(order);
        if (!recovered.ok) {
          toast.push(recovered.message, "error");
          await reloadDrafts();
          return;
        }
        setPhone(recovered.value.customer_phone);
        setName(recovered.value.customer_name);
        setNote(recovered.value.note);
        setPricing(
          Object.freeze({
            discount_cents: recovered.value.discount_cents,
            urgent: recovered.value.urgent,
            freight: recovered.value.freight,
          }),
        );
        setPaymentCents("0");
        setLines(recovered.value.lines);
        setDraftId(recovered.value.draft_id);
        setFocusedLineKey(recovered.value.lines[0]?.key ?? null);
        setResult(null);
        setTicketPreview(null);
        store.patch({ phase: "editing", dirty: false, message: "" });
        toast.push("挂单已完整恢复，可继续编辑后开单", "success");
      } catch {
        toast.push("无法恢复挂单，请检查服务连接", "error");
      } finally {
        setBusy(false);
      }
    },
    [
      queryClient,
      reloadDrafts,
      toast,
      store,
      confirmDiscard,
      setBusy,
      setPhone,
      setName,
      setNote,
      setPricing,
      setPaymentCents,
      setLines,
      setDraftId,
      setFocusedLineKey,
      setResult,
      setTicketPreview,
    ],
  );

  const onSubmit = useCallback(
    async (retry = false) => {
      if (!retry && store.getSnapshot().phase !== "editing") return;
      const built = build(true);
      if (!built.ok) {
        toast.push(built.message, "error");
        return;
      }
      const payload = await submitReceive(store, commandClient, built.body, retry);
      if (payload === null) {
        const failure = store.getSnapshot().message;
        if (failure) toast.push(failure, "error");
        return;
      }
      const preview = buildReceiveTicketPreview({
        result: payload,
        lines: built.previewLines as readonly TicketPreviewLineDraft[],
        storeName,
        ...(storePhone === undefined ? {} : { storePhone }),
        receiveDate: formatReceiveDateLabel(),
        customerName: name.trim() || null,
        customerPhone: phone.trim() || null,
      });
      setTicketPreview(preview);
      await reloadDrafts();
      notifyReceiveSuccess(
        onTicketReady,
        preview,
        payload.ticket_no,
        payload.waivers.skip_ticket_print,
        toast.push,
      );
    },
    [
      build,
      commandClient,
      name,
      onTicketReady,
      phone,
      reloadDrafts,
      storeName,
      storePhone,
      toast,
      store,
      setTicketPreview,
    ],
  );

  useReceiveKeyboard(pageRef, {
    canSubmit: !busy && policyReady && phase === "editing",
    onSubmit: () => void onSubmit(),
  });

  const onReset = useCallback(async () => {
    if (store.getSnapshot().busy) return;
    if (store.getSnapshot().phase === "uncertain") return;
    if (
      store.getSnapshot().dirty &&
      !(await confirmDiscard("清空将丢弃当前未暂存的内容，是否继续？"))
    )
      return;
    store.reset();
  }, [store, confirmDiscard]);

  return (
    <main ref={pageRef} className="ld-shell-main ld-receive" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">开单</h1>
      <p className="ld-shell-main__hint">
        输入手机号后按 Enter → 搜索或点选价目加入衣物 → 核对明细 → 确认开单出票。
      </p>
      <div className="ld-panel__note" role={recoveryStatus === "error" ? "alert" : "status"}>
        {recoveryMessage}
        {recoveryStatus === "error" ? (
          <Button type="button" variant="secondary" onClick={() => void store.retryRecovery()}>
            重试恢复
          </Button>
        ) : null}
      </div>
      <ReceiveProgressPanel
        state={store.getSnapshot()}
        store={store}
        confirmDiscard={confirmDiscard}
        onReset={() => void onReset()}
        onRetry={() => void onSubmit(true)}
      />
      {phase !== "editing" ? null : (
        <>
          {queryClient === undefined ? null : (
            <ReceiveDraftPanel
              rows={draftRows}
              loading={draftLoading}
              busy={busy}
              activeDraftId={draftId}
              onRefresh={() => void reloadDrafts()}
              onResume={(orderId) => void onResumeDraft(orderId)}
            />
          )}
          <div className="ld-counter-grid ld-counter-grid--receive">
            {queryClient === undefined ? null : (
              <section className="ld-counter-panel ld-receive-catalog" aria-label="价目">
                <CatalogPicker queryClient={queryClient} disabled={busy} onPick={onPickCatalog} />
              </section>
            )}
            <ReceiveLineEditor
              lines={lines}
              focusedLineKey={focusedLineKey}
              busy={busy}
              activeAddons={activePricingAddons(policy)}
              onFocusLine={setFocusedLineKey}
              onChange={setLines}
            />
            <ReceiveSettlementPanel
              {...(scalePort === undefined ? {} : { scalePort })}
              busy={busy}
              policyReady={policyReady}
              canDiscount={canDiscount}
              draftId={draftId}
              pricing={pricing}
              policy={policy}
              totals={totals}
              paymentCents={paymentCents}
              paymentMethod={paymentMethod}
              note={note}
              phone={phone}
              name={name}
              onPhoneChange={setPhone}
              onNameChange={setName}
              onPricingChange={setPricing}
              onPaymentCentsChange={setPaymentCents}
              onPaymentMethodChange={setPaymentMethod}
              onNoteChange={setNote}
              onSubmit={() => void onSubmit()}
              submitBlocked={recoveryStatus === "error"}
              onHold={() => void onHold()}
              onReset={() => void onReset()}
            />
          </div>
        </>
      )}
      {phase === "editing" ? (
        <ReceiveCheckoutShortcut total={totals.payable} pageRef={pageRef} />
      ) : null}
      <ReceiveCompletedWorkspace
        store={store}
        busy={busy}
        commandClient={commandClient}
        queuePrintEnabled={queuePrintEnabled}
        {...(onTicketReady === undefined ? {} : { onTicketReady })}
        {...(paymentChannelPort === undefined ? {} : { paymentChannelPort })}
        {...(photoPort === undefined ? {} : { photoPort })}
        {...(queryClient === undefined ? {} : { queryClient })}
      />
    </main>
  );
}
