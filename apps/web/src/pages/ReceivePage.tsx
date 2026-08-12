import type { TicketPreview } from "@laundry/domain";
import { Input, useToast } from "@laundry/ui";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { StaffRole } from "../auth/permissions.js";
import type { CatalogListItem } from "../commands/query-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { CatalogPicker } from "./CatalogPicker.js";
import { recoverDraftForm } from "./draft-recovery.js";
import { parseOrderListRows, unwrapQueryResult, type OrderListRowView } from "./OrdersList.js";
import { applyCatalogPick, ReceiveLineEditor } from "./ReceiveLineEditor.js";
import { ReceiveDraftPanel } from "./ReceiveDraftPanel.js";
import { ReceiveResult } from "./ReceiveResult.js";
import {
  buildReceiveBody,
  newLineDraft,
  parseHoldDraftId,
  parseOrderGetResult,
  parseReceiveOrderResult,
  unwrapCommandResult,
  type PaymentMethod,
  type ReceiveLineDraft,
  type ReceiveOrderResult,
} from "./order-form.js";
import {
  activePricingAddons,
  EMPTY_PRICING_POLICY,
  readPricingPolicy,
  type PricingPolicyView,
} from "./pricing-policy-model.js";
import {
  EMPTY_PRICING_SELECTION,
  previewReceiveTotals,
  type PricingSelection,
} from "./receive-pricing-selection.js";
import { ReceiveSettlementPanel } from "./ReceiveSettlementPanel.js";
import { TicketPrintWaiverNotice } from "./TicketPrintWaiverNotice.js";
import { TicketPreviewPanel } from "./TicketPreviewPanel.js";
import {
  buildReceiveTicketPreview,
  formatReceiveDateLabel,
  type TicketPreviewLineDraft,
} from "./ticket-preview.js";
import { enqueueTicketPrint, notifyReceiveSuccess } from "./ticket-print-enqueue.js";

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
};

export function ReceivePage({
  commandClient,
  queryClient,
  storeName = "洗衣店",
  storePhone,
  onTicketReady,
  queuePrintEnabled = false,
  role,
}: ReceivePageProps) {
  const toast = useToast();
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [paymentCents, setPaymentCents] = useState("0");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [pricing, setPricing] = useState<PricingSelection>(EMPTY_PRICING_SELECTION);
  const [policy, setPolicy] = useState<PricingPolicyView>(EMPTY_PRICING_POLICY);
  const [policyReady, setPolicyReady] = useState(queryClient === undefined);
  const [note, setNote] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftRows, setDraftRows] = useState<readonly OrderListRowView[]>([]);
  const [draftLoading, setDraftLoading] = useState(false);
  const [lines, setLines] = useState<readonly ReceiveLineDraft[]>(() => [newLineDraft(0)]);
  const [focusedLineKey, setFocusedLineKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReceiveOrderResult | null>(null);
  const [ticketPreview, setTicketPreview] = useState<TicketPreview | null>(null);
  const totals = useMemo(
    () => previewReceiveTotals(lines, pricing, policy),
    [lines, policy, pricing],
  );
  const canDiscount = role === "admin";

  const reloadPolicy = useCallback(async () => {
    if (queryClient === undefined) return;
    try {
      const response = await queryClient.execute<unknown>("pricing.policy.get", {});
      if (!response.ok) {
        setPolicyReady(false);
        toast.push(response.error.message ?? response.error.code, "error");
        return;
      }
      const parsed = readPricingPolicy(response.data);
      if (parsed === null) {
        setPolicyReady(false);
        toast.push("计价设置返回格式无效", "error");
        return;
      }
      setPolicy(parsed);
      setPolicyReady(true);
    } catch {
      setPolicyReady(false);
      toast.push("无法读取计价设置，请检查服务连接", "error");
    }
  }, [queryClient, toast]);

  useEffect(() => {
    void reloadPolicy();
  }, [reloadPolicy]);

  const reloadDrafts = useCallback(async () => {
    if (queryClient === undefined) return;
    setDraftLoading(true);
    try {
      const response = await queryClient.execute<unknown>("order.list", {
        status: "draft",
        limit: 20,
      });
      if (!response.ok) {
        setDraftRows([]);
        toast.push(response.error.message ?? response.error.code, "error");
        return;
      }
      const parsed = parseOrderListRows(unwrapQueryResult(response.data));
      if (parsed === null) {
        setDraftRows([]);
        toast.push("挂单列表返回格式无效", "error");
        return;
      }
      setDraftRows(Object.freeze(parsed.filter((row) => row.status === "draft")));
    } catch {
      setDraftRows([]);
      toast.push("无法读取挂单列表，请检查服务连接", "error");
    } finally {
      setDraftLoading(false);
    }
  }, [queryClient, toast]);

  useEffect(() => {
    void reloadDrafts();
  }, [reloadDrafts]);

  const onPickCatalog = useCallback(
    (item: CatalogListItem) => {
      setLines((current) => {
        const applied = applyCatalogPick(current, focusedLineKey, item);
        setFocusedLineKey(applied.focusedKey);
        return applied.lines;
      });
    },
    [focusedLineKey],
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
      setDraftId(receivedDraftId);
      await reloadDrafts();
      toast.push("已暂存挂单；确认开单后才会生成票号与收款", "success");
    } catch {
      toast.push("无法暂存挂单，请检查服务连接", "error");
    } finally {
      setBusy(false);
    }
  }, [build, commandClient, reloadDrafts, toast]);

  const onResumeDraft = useCallback(
    async (orderId: string) => {
      if (queryClient === undefined) return;
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
        toast.push("挂单已完整恢复，可继续编辑后开单", "success");
      } catch {
        toast.push("无法恢复挂单，请检查服务连接", "error");
      } finally {
        setBusy(false);
      }
    },
    [queryClient, reloadDrafts, toast],
  );

  const onSubmit = useCallback(async () => {
    const built = build(true);
    if (!built.ok) {
      toast.push(built.message, "error");
      return;
    }
    setBusy(true);
    try {
      const res = await commandClient.execute<unknown>("order.receive", built.body);
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        return;
      }
      const payload = parseReceiveOrderResult(unwrapCommandResult(res.data));
      if (payload === null) {
        toast.push("开单成功但结果无法解析", "error");
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
      setResult(payload);
      setTicketPreview(preview);
      setDraftId(null);
      await reloadDrafts();
      notifyReceiveSuccess(
        onTicketReady,
        preview,
        payload.ticket_no,
        payload.waivers.skip_ticket_print,
        toast.push,
      );
    } catch {
      toast.push("无法提交开单，请检查服务连接", "error");
    } finally {
      setBusy(false);
    }
  }, [
    build,
    commandClient,
    name,
    onTicketReady,
    phone,
    reloadDrafts,
    storeName,
    storePhone,
    toast,
  ]);

  const onReset = useCallback(() => {
    setPhone("");
    setName("");
    setPaymentCents("0");
    setPaymentMethod("cash");
    setPricing(EMPTY_PRICING_SELECTION);
    setNote("");
    setDraftId(null);
    setLines([newLineDraft(0)]);
    setFocusedLineKey(null);
    setResult(null);
    setTicketPreview(null);
  }, []);

  const onEnqueuePrint = useCallback(async () => {
    if (result === null) return false;
    return enqueueTicketPrint(commandClient, result.order_id, result.ticket_no, toast.push);
  }, [commandClient, result, toast]);

  return (
    <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">开单</h1>
      <p className="ld-shell-main__hint">
        先选价目，再录件数与结算。提交时由服务端重新定价并写入支付台账。
      </p>
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
        <section className="ld-counter-panel" aria-label="客户与价目">
          <h2 className="ld-counter-panel__title">客户与价目</h2>
          <Input
            name="customer-phone"
            label="手机号（可选）"
            inputMode="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            disabled={busy}
          />
          <Input
            name="customer-name"
            label="客户姓名（可选）"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
          {queryClient === undefined ? null : (
            <CatalogPicker queryClient={queryClient} disabled={busy} onPick={onPickCatalog} />
          )}
        </section>
        <ReceiveLineEditor
          lines={lines}
          focusedLineKey={focusedLineKey}
          busy={busy}
          activeAddons={activePricingAddons(policy)}
          onFocusLine={setFocusedLineKey}
          onChange={setLines}
        />
        <ReceiveSettlementPanel
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
          onPricingChange={setPricing}
          onPaymentCentsChange={setPaymentCents}
          onPaymentMethodChange={setPaymentMethod}
          onNoteChange={setNote}
          onSubmit={() => void onSubmit()}
          onHold={() => void onHold()}
          onReset={onReset}
        />
      </div>
      {result === null ? null : <ReceiveResult result={result} />}
      {ticketPreview === null || result === null ? null : (
        <>
          <TicketPreviewPanel
            key={result.order_id}
            preview={ticketPreview}
            onTicketReady={onTicketReady}
            {...(queuePrintEnabled ? { onEnqueuePrint } : {})}
            disabled={busy || result.waivers.skip_ticket_print}
          />
          {result.waivers.skip_ticket_print ? <TicketPrintWaiverNotice /> : null}
        </>
      )}
    </main>
  );
}
