/** Counter receive flow: catalog-priced lines, settlement preview, and resumable holds. */

import type { TicketPreview } from "@laundry/domain";
import { Button, Input, MoneyText, useToast } from "@laundry/ui";
import { useCallback, useMemo, useState } from "react";

import type { CatalogListItem } from "../commands/query-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { CatalogPicker } from "./CatalogPicker.js";
import { applyCatalogPick, ReceiveLineEditor } from "./ReceiveLineEditor.js";
import { ReceiveResult } from "./ReceiveResult.js";
import {
  buildReceiveBody,
  newLineDraft,
  parseNonNegCents,
  unwrapCommandResult,
  type PaymentMethod,
  type ReceiveLineDraft,
  type ReceiveOrderResult,
} from "./order-form.js";
import { TicketPreviewPanel } from "./TicketPreviewPanel.js";
import {
  buildReceiveTicketPreview,
  formatReceiveDateLabel,
  type TicketPreviewLineDraft,
} from "./ticket-preview.js";

export type ReceivePageProps = {
  commandClient: CommandPort;
  queryClient?: QueryPort;
  storeName?: string;
  storePhone?: string;
  onTicketReady?: (preview: TicketPreview) => void;
  /** Only the packaged desktop host has a local signed-print queue. */
  queuePrintEnabled?: boolean;
};

type AdjustmentText = Readonly<{
  discount_cents: string;
  addon_cents: string;
  urgent_cents: string;
  freight_cents: string;
}>;

const DEFAULT_STORE_NAME = "洗衣店";
const EMPTY_ADJUSTMENTS: AdjustmentText = Object.freeze({
  discount_cents: "0",
  addon_cents: "0",
  urgent_cents: "0",
  freight_cents: "0",
});

const paymentMethods: readonly Readonly<{ value: PaymentMethod; label: string }>[] = Object.freeze([
  Object.freeze({ value: "cash", label: "现金" }),
  Object.freeze({ value: "wechat", label: "微信" }),
  Object.freeze({ value: "alipay", label: "支付宝" }),
  Object.freeze({ value: "other", label: "其他" }),
]);

type PrintNotification = (message: string, kind: "success" | "error") => void;

/** Submit the server-authoritative order identity to the local print queue. */
export async function enqueueTicketPrint(
  commandClient: CommandPort,
  orderId: string,
  ticketNo: string,
  notify: PrintNotification,
): Promise<boolean> {
  try {
    const res = await commandClient.execute<unknown>("print.ticket.enqueue", {
      order_id: orderId,
    });
    if (!res.ok) {
      notify(res.error.message ?? res.error.code, "error");
      return false;
    }
    notify(`已排队打印 ${ticketNo}`, "success");
    return true;
  } catch {
    notify("无法提交打印任务，请检查本地服务连接", "error");
    return false;
  }
}

function previewTotals(lines: readonly ReceiveLineDraft[], adjustments: AdjustmentText) {
  const original = lines.reduce(
    (total, line) => total + (line.unit_price_cents ?? 0) * (parseNonNegCents(line.qty) ?? 0),
    0,
  );
  const discount = parseNonNegCents(adjustments.discount_cents) ?? 0;
  const addon = parseNonNegCents(adjustments.addon_cents) ?? 0;
  const urgent = parseNonNegCents(adjustments.urgent_cents) ?? 0;
  const freight = parseNonNegCents(adjustments.freight_cents) ?? 0;
  return Object.freeze({
    original,
    discount,
    addon,
    urgent,
    freight,
    payable: Math.max(0, original - discount + addon + urgent + freight),
  });
}

export function ReceivePage({
  commandClient,
  queryClient,
  storeName = DEFAULT_STORE_NAME,
  storePhone,
  onTicketReady,
  queuePrintEnabled = false,
}: ReceivePageProps) {
  const toast = useToast();
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [paymentCents, setPaymentCents] = useState("0");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [adjustments, setAdjustments] = useState<AdjustmentText>(EMPTY_ADJUSTMENTS);
  const [note, setNote] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [lines, setLines] = useState<readonly ReceiveLineDraft[]>(() => [newLineDraft(0)]);
  const [focusedLineKey, setFocusedLineKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReceiveOrderResult | null>(null);
  const [ticketPreview, setTicketPreview] = useState<TicketPreview | null>(null);
  const totals = useMemo(() => previewTotals(lines, adjustments), [adjustments, lines]);

  const updateAdjustment = useCallback((key: keyof AdjustmentText, value: string) => {
    setAdjustments((current) => Object.freeze({ ...current, [key]: value }));
  }, []);

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
        ...adjustments,
        note,
        lines,
        ...(draftId === null ? {} : { draft_id: draftId }),
      }),
    [adjustments, draftId, lines, name, note, paymentCents, paymentMethod, phone],
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
      const payload = unwrapCommandResult<{ draft_id?: string }>(res.data);
      if (payload === null || typeof payload.draft_id !== "string") {
        toast.push("暂存成功但挂单标识无法解析", "error");
        return;
      }
      setDraftId(payload.draft_id);
      toast.push("已暂存挂单；确认开单后才会生成票号与收款", "success");
    } finally {
      setBusy(false);
    }
  }, [build, commandClient, toast]);

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
      const payload = unwrapCommandResult<ReceiveOrderResult>(res.data);
      if (payload === null || typeof payload.ticket_no !== "string") {
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
      onTicketReady?.(preview);
      toast.push(`开单成功 ${payload.ticket_no}`, "success");
    } finally {
      setBusy(false);
    }
  }, [build, commandClient, name, onTicketReady, phone, storeName, storePhone, toast]);

  const onReset = useCallback(() => {
    setPhone("");
    setName("");
    setPaymentCents("0");
    setPaymentMethod("cash");
    setAdjustments(EMPTY_ADJUSTMENTS);
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
          onFocusLine={setFocusedLineKey}
          onChange={setLines}
        />
        <section className="ld-counter-panel ld-counter-panel--settlement" aria-label="结算">
          <div className="ld-counter-panel__head">
            <h2 className="ld-counter-panel__title">结算</h2>
            {draftId === null ? null : <span className="ld-counter-draft">挂单待确认</span>}
          </div>
          <div className="ld-counter-adjustments">
            <Input
              name="discount-cents"
              label="折扣（分）"
              inputMode="numeric"
              value={adjustments.discount_cents}
              onChange={(event) => updateAdjustment("discount_cents", event.target.value)}
              disabled={busy}
            />
            <Input
              name="addon-cents"
              label="附加（分）"
              inputMode="numeric"
              value={adjustments.addon_cents}
              onChange={(event) => updateAdjustment("addon_cents", event.target.value)}
              disabled={busy}
            />
            <Input
              name="urgent-cents"
              label="加急（分）"
              inputMode="numeric"
              value={adjustments.urgent_cents}
              onChange={(event) => updateAdjustment("urgent_cents", event.target.value)}
              disabled={busy}
            />
            <Input
              name="freight-cents"
              label="运费（分）"
              inputMode="numeric"
              value={adjustments.freight_cents}
              onChange={(event) => updateAdjustment("freight_cents", event.target.value)}
              disabled={busy}
            />
          </div>
          <div className="ld-counter-totals" aria-label="本地预览">
            <span>
              原价 <MoneyText fen={totals.original} />
            </span>
            <span>
              折扣 −<MoneyText fen={totals.discount} />
            </span>
            <span>
              附加 +<MoneyText fen={totals.addon + totals.urgent + totals.freight} />
            </span>
            <strong>
              应收预览 <MoneyText fen={totals.payable} />
            </strong>
          </div>
          <Input
            name="initial-payment"
            label="首笔收款（分）"
            inputMode="numeric"
            value={paymentCents}
            onChange={(event) => setPaymentCents(event.target.value)}
            hint="0 表示欠款，不写 payment 流水"
            disabled={busy}
          />
          <label className="ld-counter-select">
            <span>付款方式</span>
            <select
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}
              disabled={busy}
            >
              {paymentMethods.map((method) => (
                <option key={method.value} value={method.value}>
                  {method.label}
                </option>
              ))}
            </select>
          </label>
          <Input
            name="note"
            label="备注（可选）"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={busy}
          />
          <div className="ld-counter-actions">
            <Button variant="primary" type="button" onClick={() => void onSubmit()} disabled={busy}>
              {busy ? "提交中…" : draftId === null ? "确认开单" : "确认挂单并开单"}
            </Button>
            <Button variant="secondary" type="button" onClick={() => void onHold()} disabled={busy}>
              暂存挂单
            </Button>
            <Button variant="ghost" type="button" onClick={onReset} disabled={busy}>
              清空
            </Button>
          </div>
          <p className="ld-counter-panel__hint">
            预览只作输入反馈；价格、应收和支付由服务端权威计算。
          </p>
        </section>
      </div>
      {result === null ? null : <ReceiveResult result={result} />}
      {ticketPreview === null || result === null ? null : (
        <TicketPreviewPanel
          key={result.order_id}
          preview={ticketPreview}
          onTicketReady={onTicketReady}
          {...(queuePrintEnabled ? { onEnqueuePrint } : {})}
          disabled={busy}
        />
      )}
    </main>
  );
}
