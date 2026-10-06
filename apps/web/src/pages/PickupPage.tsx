/**
 * 取衣（order.pickup）— M2 counter form with partial multi-select via order.get.
 */

import { Button, EmptyState, Icon, MoneyInput, useToast } from "@laundry/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommandPort, QueryPort } from "../commands/types.js";
import {
  buildPickupBody,
  isValidUuid,
  parseOrderGetResult,
  selectAllPickableIds,
  toggleGarmentSelection,
  unwrapCommandResult,
  type OrderGetResult,
  type PickupOrderResult,
} from "./order-form.js";
import { OrderLookupCandidates, parseOrderLookupRows } from "./OrderLookupCandidates.js";
import type { PaymentChannelPort } from "../host/payment-channel-port.js";
import { ChannelCollectCard } from "./ChannelCollectCard.js";
import { PaymentCollectionDialog } from "./PaymentCollectionDialog.js";
import { PickupResult, withPickupDetails, type PickupResultView } from "./PickupDetails.js";
import { PickupOrderPanel } from "./PickupOrderPanel.js";
import { PickupLookupForm } from "./PickupLookupForm.js";
import { mayHandOffFocus, useScanFocus } from "./use-scan-focus.js";

/** Fields a finished lookup may move the caret out of (never 本次收款 etc.). */
const PICKUP_SCAN_FIELDS = Object.freeze(["pickup-key", "pickup-verification-barcode"]);

export type PickupPageProps = {
  commandClient: CommandPort;
  /** Required for 加载订单 (order.get). Optional only for SSR shell smoke. */
  queryClient?: QueryPort;
  /** Prefill order id (e.g. from workbench order.list row click). */
  initialOrderId?: string;
  /** Prefill a customer-facing lookup key from the workbench scanner input. */
  initialLookupKey?: string;
  /** WeChat/Alipay QR collection (ADR-85 r1); absent when the host has no channel port. */
  paymentChannelPort?: PaymentChannelPort;
};

export function PickupPage({
  commandClient,
  queryClient,
  initialOrderId,
  initialLookupKey,
  paymentChannelPort,
}: PickupPageProps) {
  const toast = useToast();
  const [lookupKey, setLookupKey] = useState(() => initialLookupKey ?? "");
  const [orderId, setOrderId] = useState(() => initialOrderId ?? "");
  const [collectText, setCollectText] = useState("0");
  const [busy, setBusy] = useState(false);
  const [loadingOrder, setLoadingOrder] = useState(false);
  const [loaded, setLoaded] = useState<OrderGetResult | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [result, setResult] = useState<PickupResultView | null>(null);
  const [matches, setMatches] = useState<ReturnType<typeof parseOrderLookupRows>>([]);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [verificationBarcode, setVerificationBarcode] = useState("");
  const [verifiedBarcodes, setVerifiedBarcodes] = useState<ReadonlySet<string>>(() => new Set());
  const [channelRefresh, setChannelRefresh] = useState(0);
  const lookupSeqRef = useRef(0);

  const selectedRacked = useMemo(
    () =>
      loaded?.garments.filter(
        (garment) => garment.status === "racked" && selected.has(garment.garment_id),
      ) ?? [],
    [loaded, selected],
  );
  const verifiedRequired = selectedRacked.filter((garment) =>
    verifiedBarcodes.has(garment.barcode.toUpperCase()),
  ).length;

  const loadOrderById = useCallback(
    async (id: string, seq: number, inputAtRequest: string) => {
      if (queryClient === undefined) return;
      const res = await queryClient.execute<unknown>("order.get", { order_id: id });
      if (seq !== lookupSeqRef.current) return;
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        setLoaded(null);
        setSelected(new Set());
        setVerifiedBarcodes(new Set());
        return;
      }
      const payload = unwrapCommandResult(res.data);
      const parsed = parseOrderGetResult(payload);
      if (parsed === null) {
        toast.push("订单结果无法解析", "error");
        setLoaded(null);
        setSelected(new Set());
        setVerifiedBarcodes(new Set());
        return;
      }
      setLoaded(parsed);
      setOrderId(parsed.order_id);
      const ticket = parsed.ticket_no;
      if (ticket !== null) {
        setLookupKey((current) => (current === inputAtRequest ? ticket : current));
      }
      setMatches([]);
      const pickableIds = selectAllPickableIds(parsed.garments);
      setSelected(pickableIds);
      setVerifiedBarcodes(new Set());
      setVerificationBarcode("");
      if (pickableIds.size === 0) {
        toast.push("订单已加载，但没有可取衣物", "info");
      } else {
        toast.push(`已加载 ${parsed.ticket_no ?? "挂单"}，${pickableIds.size} 件可取`, "success");
      }
    },
    [queryClient, toast],
  );

  const onLoadOrder = useCallback(
    async (overrideKey?: string) => {
      if (queryClient === undefined) {
        toast.push("查询通道不可用", "error");
        return;
      }
      const key = (overrideKey ?? lookupKey).trim();
      if (key.length === 0) {
        toast.push("请输入票号、取件码、衣物条码、手机号或姓名", "error");
        return;
      }
      const seq = (lookupSeqRef.current += 1);
      setLoadingOrder(true);
      setResult(null);
      try {
        if (isValidUuid(key)) {
          await loadOrderById(key, seq, lookupKey);
          return;
        }
        const res = await queryClient.execute<unknown>("order.lookup", {
          key,
          status: "open",
          limit: 20,
        });
        if (seq !== lookupSeqRef.current) return;
        if (!res.ok) {
          toast.push(res.error.message ?? res.error.code, "error");
          setLoaded(null);
          setSelected(new Set());
          setVerifiedBarcodes(new Set());
          return;
        }
        const found = parseOrderLookupRows(unwrapCommandResult(res.data));
        if (found === null) {
          toast.push("订单查询结果无法解析", "error");
          return;
        }
        setMatches(found);
        if (found.length === 0) {
          toast.push("未找到匹配订单；请核对输入", "error");
          setLoaded(null);
          setSelected(new Set());
          setVerifiedBarcodes(new Set());
          return;
        }
        if (found.length === 1) await loadOrderById(found[0]!.order_id, seq, lookupKey);
        else toast.push(`找到 ${found.length} 张订单，请选择`, "info");
      } finally {
        if (seq === lookupSeqRef.current) setLoadingOrder(false);
      }
    },
    [loadOrderById, lookupKey, queryClient, toast],
  );

  // Opening 取衣 with an order or a lookup (工作台 / 命令面板 / 订单详情) loads it.
  const pageRef = useRef<HTMLElement | null>(null);
  useScanFocus(pageRef, 'input[name="pickup-key"]');
  const autoLoadRef = useRef(false);
  useEffect(() => {
    if (autoLoadRef.current || queryClient === undefined) return;
    autoLoadRef.current = true;
    const initialKey = initialOrderId ?? initialLookupKey;
    if (initialKey !== undefined && initialKey.trim().length > 0) void onLoadOrder(initialKey);
  }, [initialLookupKey, initialOrderId, onLoadOrder, queryClient]);

  const onToggle = useCallback(
    (garmentId: string) => {
      const barcode = loaded?.garments.find((garment) => garment.garment_id === garmentId)?.barcode;
      setSelected((prev) => toggleGarmentSelection(prev, garmentId));
      if (barcode !== undefined) {
        setVerifiedBarcodes((prev) => {
          const next = new Set(prev);
          next.delete(barcode.toUpperCase());
          return next;
        });
      }
    },
    [loaded],
  );

  const onSelectAll = useCallback(() => {
    if (loaded === null) return;
    setSelected(selectAllPickableIds(loaded.garments));
    setVerifiedBarcodes(new Set());
  }, [loaded]);

  const onSelectNone = useCallback(() => {
    setSelected(new Set());
    setVerifiedBarcodes(new Set());
  }, []);

  const onVerify = useCallback(() => {
    const barcode = verificationBarcode.trim().toUpperCase();
    const match = selectedRacked.find((garment) => garment.barcode.toUpperCase() === barcode);
    if (match === undefined) {
      toast.push("条码不属于已选的上架衣物", "error");
      return;
    }
    setVerifiedBarcodes((prev) => new Set(prev).add(barcode));
    setVerificationBarcode("");
    toast.push(`已复核 ${barcode}`, "success");
  }, [selectedRacked, toast, verificationBarcode]);

  const onSubmit = useCallback(async () => {
    const built = buildPickupBody({
      order_id: orderId,
      collect_cents: collectText,
      garment_ids: [...selected],
      verification_barcodes: [...verifiedBarcodes],
      require_selection: true,
    });
    if (!built.ok) {
      toast.push(built.message, "error");
      return;
    }
    setBusy(true);
    try {
      const res = await commandClient.execute<unknown>("order.pickup", built.body);
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        // An unfinished QR collection holds the order: show it so staff can resolve it.
        if (res.error.detail?.reason === "payment_pending") setChannelRefresh((n) => n + 1);
        return;
      }
      const payload = unwrapCommandResult<PickupOrderResult>(res.data);
      if (payload === null || typeof payload.order_id !== "string") {
        toast.push("取衣成功但结果无法解析", "error");
        return;
      }
      setResult(withPickupDetails(payload, loaded));
      toast.push(`取衣完成 ${payload.ticket_no ?? payload.order_id}`, "success");
      // Clear selection of picked items; keep summary until reset.
      setSelected(new Set());
      setVerifiedBarcodes(new Set());
      setLoaded(null);
    } finally {
      setBusy(false);
    }
  }, [collectText, commandClient, loaded, orderId, selected, toast, verifiedBarcodes]);

  const onReset = useCallback(() => {
    setLookupKey("");
    setOrderId("");
    setCollectText("0");
    setLoaded(null);
    setSelected(new Set());
    setResult(null);
    setMatches([]);
    setPaymentOpen(false);
    setVerificationBarcode("");
    setVerifiedBarcodes(new Set());
  }, []);

  const disabled = busy || loadingOrder;

  // Once a lookup or pickup settles, hand the scanner to the next step:
  // garment verification when racked pieces need it, else the lookup field.
  useEffect(() => {
    const root = pageRef.current;
    if (root === null || disabled || (loaded === null && result === null)) return;
    const doc = root.ownerDocument;
    if (doc.querySelector('[aria-modal="true"]') !== null) return;
    if (!mayHandOffFocus(doc.activeElement, PICKUP_SCAN_FIELDS)) return;
    const next =
      root.querySelector<HTMLInputElement>('input[name="pickup-verification-barcode"]') ??
      root.querySelector<HTMLInputElement>('input[name="pickup-key"]');
    next?.focus({ preventScroll: true });
    if (next?.name === "pickup-key") next.select();
  }, [disabled, loaded, result]);
  const verificationComplete = verifiedRequired === selectedRacked.length;

  return (
    <main ref={pageRef} className="ld-shell-main ld-pickup" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">取衣</h1>
      <p className="ld-shell-main__hint">
        扫码或输入后按 Enter 查找订单，勾选要取的衣物（可部分取），核对收款后确认取衣。
      </p>

      <div className="ld-order-form">
        <PickupLookupForm
          value={lookupKey}
          busy={busy}
          loading={loadingOrder}
          queryAvailable={queryClient !== undefined}
          onChange={setLookupKey}
          onLookup={() => void onLoadOrder()}
        />

        {matches === null ? null : (
          <OrderLookupCandidates
            orders={matches}
            disabled={disabled}
            onSelect={(id) => void onLoadOrder(id)}
          />
        )}

        {loaded === null && (matches === null || matches.length === 0) && result === null ? (
          <EmptyState
            className="ld-pickup__empty"
            icon={<Icon name="scan" size={26} />}
            title="等待扫码或输入"
            description="加载订单后，这里会列出可取衣物、上架位置与应收余额。"
          />
        ) : null}

        {loaded !== null ? (
          <PickupOrderPanel
            order={loaded}
            selected={selected}
            verifiedBarcodes={verifiedBarcodes}
            verificationBarcode={verificationBarcode}
            verifiedRequired={verifiedRequired}
            requiredVerification={selectedRacked.length}
            disabled={disabled}
            onSelectAll={onSelectAll}
            onSelectNone={onSelectNone}
            onToggle={onToggle}
            onVerificationBarcodeChange={setVerificationBarcode}
            onVerify={onVerify}
          />
        ) : null}

        {loaded !== null && paymentChannelPort !== undefined ? (
          <ChannelCollectCard
            port={paymentChannelPort}
            order={loaded}
            refreshKey={channelRefresh}
            disabled={disabled}
            onPaid={() => {
              setCollectText("0");
              void onLoadOrder(loaded.order_id);
            }}
          />
        ) : null}

        <div className="ld-order-form__actions">
          <MoneyInput
            name="collect-cents"
            label="本次收款（填 0 不收）"
            valueFen={collectText}
            onChangeFen={setCollectText}
            disabled={disabled}
          />
          <Button
            variant="primary"
            size="lg"
            type="button"
            onClick={() => void onSubmit()}
            disabled={disabled || !verificationComplete}
          >
            {busy ? "提交中…" : "确认取衣"}
          </Button>
          {loaded !== null && loaded.status === "open" && loaded.balance_cents > 0 ? (
            <Button
              variant="secondary"
              type="button"
              onClick={() => setPaymentOpen(true)}
              disabled={disabled}
            >
              独立收款 / 补缴
            </Button>
          ) : null}
          <Button variant="ghost" type="button" onClick={onReset} disabled={disabled}>
            清空
          </Button>
        </div>
      </div>

      {result === null ? null : <PickupResult result={result} />}
      {loaded === null ? null : (
        <PaymentCollectionDialog
          open={paymentOpen}
          order={loaded}
          commandClient={commandClient}
          onClose={() => setPaymentOpen(false)}
          onCompleted={() => void onLoadOrder(loaded.order_id)}
        />
      )}
    </main>
  );
}
