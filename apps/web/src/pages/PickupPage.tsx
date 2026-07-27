/**
 * 取衣（order.pickup）— M2 counter form with partial multi-select via order.get.
 */

import { Button, Input, MoneyText, StatusBadge, useToast } from "@laundry/ui";
import { useCallback, useMemo, useState } from "react";
import type { CommandPort, QueryPort } from "../commands/types.js";
import {
  buildPickupBody,
  isValidUuid,
  isPickableGarmentStatus,
  listPickableGarments,
  parseOrderGetResult,
  selectAllPickableIds,
  toggleGarmentSelection,
  unwrapCommandResult,
  type OrderGetResult,
  type PickupOrderResult,
} from "./order-form.js";
import { OrderLookupCandidates, parseOrderLookupRows } from "./OrderLookupCandidates.js";
import { PaymentCollectionDialog } from "./PaymentCollectionDialog.js";
import { PickupGarmentCheckRow, PickupResult } from "./PickupDetails.js";

export type PickupPageProps = {
  commandClient: CommandPort;
  /** Required for 加载订单 (order.get). Optional only for SSR shell smoke. */
  queryClient?: QueryPort;
  /** Prefill order id (e.g. from workbench order.list row click). */
  initialOrderId?: string;
  /** Prefill a customer-facing lookup key from the workbench scanner input. */
  initialLookupKey?: string;
};

export function PickupPage({
  commandClient,
  queryClient,
  initialOrderId,
  initialLookupKey,
}: PickupPageProps) {
  const toast = useToast();
  const [lookupKey, setLookupKey] = useState(() => initialLookupKey ?? initialOrderId ?? "");
  const [orderId, setOrderId] = useState(() => initialOrderId ?? "");
  const [collectText, setCollectText] = useState("0");
  const [busy, setBusy] = useState(false);
  const [loadingOrder, setLoadingOrder] = useState(false);
  const [loaded, setLoaded] = useState<OrderGetResult | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [result, setResult] = useState<PickupOrderResult | null>(null);
  const [matches, setMatches] = useState<ReturnType<typeof parseOrderLookupRows>>([]);
  const [paymentOpen, setPaymentOpen] = useState(false);

  const pickable = useMemo(
    () => (loaded === null ? Object.freeze([]) : listPickableGarments(loaded.garments)),
    [loaded],
  );

  const loadOrderById = useCallback(
    async (id: string) => {
      if (queryClient === undefined) return;
      const res = await queryClient.execute<unknown>("order.get", { order_id: id });
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        setLoaded(null);
        setSelected(new Set());
        return;
      }
      const payload = unwrapCommandResult(res.data);
      const parsed = parseOrderGetResult(payload);
      if (parsed === null) {
        toast.push("订单结果无法解析", "error");
        setLoaded(null);
        setSelected(new Set());
        return;
      }
      setLoaded(parsed);
      setOrderId(parsed.order_id);
      setMatches([]);
      const pickableIds = selectAllPickableIds(parsed.garments);
      setSelected(pickableIds);
      if (pickableIds.size === 0) {
        toast.push("订单已加载，但没有可取衣物", "info");
      } else {
        toast.push(`已加载 ${parsed.ticket_no ?? "挂单"}，${pickableIds.size} 件可取`, "success");
      }
    },
    [queryClient, toast],
  );

  const onLoadOrder = useCallback(async () => {
    if (queryClient === undefined) {
      toast.push("查询通道不可用", "error");
      return;
    }
    const key = lookupKey.trim();
    if (key.length === 0) {
      toast.push("请输入票号、取件码、衣物条码、手机号或姓名", "error");
      return;
    }
    setLoadingOrder(true);
    setResult(null);
    try {
      if (isValidUuid(key)) {
        await loadOrderById(key);
        return;
      }
      const res = await queryClient.execute<unknown>("order.lookup", {
        key,
        status: "open",
        limit: 20,
      });
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        setLoaded(null);
        setSelected(new Set());
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
        return;
      }
      if (found.length === 1) await loadOrderById(found[0]!.order_id);
      else toast.push(`找到 ${found.length} 张订单，请选择`, "info");
    } finally {
      setLoadingOrder(false);
    }
  }, [loadOrderById, lookupKey, queryClient, toast]);

  const onToggle = useCallback((garmentId: string) => {
    setSelected((prev) => toggleGarmentSelection(prev, garmentId));
  }, []);

  const onSelectAll = useCallback(() => {
    if (loaded === null) return;
    setSelected(selectAllPickableIds(loaded.garments));
  }, [loaded]);

  const onSelectNone = useCallback(() => {
    setSelected(new Set());
  }, []);

  const onSubmit = useCallback(async () => {
    const built = buildPickupBody({
      order_id: orderId,
      collect_cents: collectText,
      garment_ids: [...selected],
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
        return;
      }
      const payload = unwrapCommandResult<PickupOrderResult>(res.data);
      if (payload === null || typeof payload.order_id !== "string") {
        toast.push("取衣成功但结果无法解析", "error");
        return;
      }
      setResult(payload);
      toast.push(`取衣完成 ${payload.ticket_no ?? payload.order_id}`, "success");
      // Clear selection of picked items; keep summary until reset.
      setSelected(new Set());
      setLoaded(null);
    } finally {
      setBusy(false);
    }
  }, [collectText, commandClient, orderId, selected, toast]);

  const onReset = useCallback(() => {
    setLookupKey("");
    setOrderId("");
    setCollectText("0");
    setLoaded(null);
    setSelected(new Set());
    setResult(null);
    setMatches([]);
    setPaymentOpen(false);
  }, []);

  const disabled = busy || loadingOrder;

  return (
    <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">取衣</h1>
      <p className="ld-shell-main__hint">
        输入票号、取件码、衣物条码、手机号或姓名后加载件列表，勾选要取的衣物（可部分取）。
      </p>

      <div className="ld-order-form">
        <div className="ld-order-form__load-row">
          <Input
            name="pickup-key"
            label="票号 / 取件码 / 条码 / 手机号 / 姓名"
            value={lookupKey}
            onChange={(event) => setLookupKey(event.target.value)}
            hint="匹配多张订单时须显式选择；订单 ID 仅用于内部跳转"
            disabled={disabled}
          />
          <div className="ld-order-form__load-action">
            <Button
              variant="secondary"
              type="button"
              onClick={() => void onLoadOrder()}
              disabled={disabled || queryClient === undefined}
            >
              {loadingOrder ? "加载中…" : "加载订单"}
            </Button>
          </div>
        </div>

        {matches === null ? null : (
          <OrderLookupCandidates
            orders={matches}
            disabled={disabled}
            onSelect={(id) => void loadOrderById(id)}
          />
        )}

        {loaded !== null ? (
          <section className="ld-pickup-order" aria-label="订单摘要">
            <dl className="ld-order-result__meta">
              <div>
                <dt>票号</dt>
                <dd data-testid="pickup-loaded-ticket">{loaded.ticket_no ?? "挂单"}</dd>
              </div>
              <div>
                <dt>取件码</dt>
                <dd>{loaded.pickup_code ?? "—"}</dd>
              </div>
              <div>
                <dt>余额</dt>
                <dd data-testid="pickup-loaded-balance">
                  <MoneyText fen={loaded.balance_cents} />
                </dd>
              </div>
              <div>
                <dt>订单状态</dt>
                <dd>
                  <StatusBadge family="order" status={loaded.status} />
                </dd>
              </div>
              <div>
                <dt>已付累计</dt>
                <dd>
                  <MoneyText fen={loaded.paid_cents} />
                </dd>
              </div>
            </dl>

            <div className="ld-pickup-garments">
              <div className="ld-pickup-garments__header">
                <h2 className="ld-pickup-garments__title">可取衣物</h2>
                <div className="ld-pickup-garments__actions">
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={onSelectAll}
                    disabled={disabled || pickable.length === 0}
                  >
                    全选可取
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={onSelectNone}
                    disabled={disabled || selected.size === 0}
                  >
                    全不选
                  </Button>
                </div>
              </div>
              {pickable.length === 0 ? (
                <p className="ld-pickup-garments__empty">没有可取衣物（仅 received 可取）</p>
              ) : (
                <ul className="ld-pickup-garments__list" data-testid="pickup-garment-list">
                  {loaded.garments.map((g) => (
                    <PickupGarmentCheckRow
                      key={g.garment_id}
                      garment={g}
                      checked={selected.has(g.garment_id)}
                      disabled={disabled || !isPickableGarmentStatus(g.status)}
                      onToggle={() => onToggle(g.garment_id)}
                    />
                  ))}
                </ul>
              )}
              <p className="ld-pickup-garments__meta">
                已选 {selected.size} / 可取 {pickable.length}
              </p>
            </div>
          </section>
        ) : null}

        <Input
          name="collect-cents"
          label="本次收款（分）"
          inputMode="numeric"
          value={collectText}
          onChange={(event) => setCollectText(event.target.value)}
          hint="整数分；0 表示不追加收款"
          disabled={disabled}
        />

        <div className="ld-order-form__actions">
          <Button
            variant="primary"
            type="button"
            onClick={() => void onSubmit()}
            disabled={disabled}
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
          onCompleted={() => void loadOrderById(loaded.order_id)}
        />
      )}
    </main>
  );
}
