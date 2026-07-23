/**
 * 取衣（order.pickup）— M2 counter form with partial multi-select via order.get.
 */

import { Button, Input, MoneyText, StatusBadge, useToast } from "@laundry/ui";
import { useCallback, useMemo, useState } from "react";
import type { CommandPort, QueryPort } from "../commands/types.js";
import {
  buildPickupBody,
  isPickableGarmentStatus,
  listPickableGarments,
  parseOrderGetResult,
  selectAllPickableIds,
  toggleGarmentSelection,
  unwrapCommandResult,
  type OrderGetGarment,
  type OrderGetResult,
  type PickupOrderResult,
} from "./order-form.js";

export type PickupPageProps = {
  commandClient: CommandPort;
  /** Required for 加载订单 (order.get). Optional only for SSR shell smoke. */
  queryClient?: QueryPort;
  /** Prefill order id (e.g. from workbench order.list row click). */
  initialOrderId?: string;
};

export function PickupPage({ commandClient, queryClient, initialOrderId }: PickupPageProps) {
  const toast = useToast();
  const [orderId, setOrderId] = useState(() => initialOrderId ?? "");
  const [collectText, setCollectText] = useState("0");
  const [busy, setBusy] = useState(false);
  const [loadingOrder, setLoadingOrder] = useState(false);
  const [loaded, setLoaded] = useState<OrderGetResult | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [result, setResult] = useState<PickupOrderResult | null>(null);

  const pickable = useMemo(
    () => (loaded === null ? Object.freeze([]) : listPickableGarments(loaded.garments)),
    [loaded],
  );

  const onLoadOrder = useCallback(async () => {
    if (queryClient === undefined) {
      toast.push("查询通道不可用", "error");
      return;
    }
    const id = orderId.trim();
    if (id.length === 0) {
      toast.push("请输入订单 ID", "error");
      return;
    }
    setLoadingOrder(true);
    setResult(null);
    try {
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
      const pickableIds = selectAllPickableIds(parsed.garments);
      setSelected(pickableIds);
      if (pickableIds.size === 0) {
        toast.push("订单已加载，但没有可取衣物", "info");
      } else {
        toast.push(`已加载 ${parsed.ticket_no}，${pickableIds.size} 件可取`, "success");
      }
    } finally {
      setLoadingOrder(false);
    }
  }, [orderId, queryClient, toast]);

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
    setOrderId("");
    setCollectText("0");
    setLoaded(null);
    setSelected(new Set());
    setResult(null);
  }, []);

  const disabled = busy || loadingOrder;

  return (
    <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">取衣</h1>
      <p className="ld-shell-main__hint">
        输入订单 UUID 后加载件列表，勾选要取的衣物（可部分取）。收款为整数分，结算余额。
      </p>

      <div className="ld-order-form">
        <div className="ld-order-form__load-row">
          <Input
            name="order-id"
            label="订单 ID"
            value={orderId}
            onChange={(event) => setOrderId(event.target.value)}
            hint="UUID，可从开单结果复制"
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

        {loaded !== null ? (
          <section className="ld-pickup-order" aria-label="订单摘要">
            <dl className="ld-order-result__meta">
              <div>
                <dt>票号</dt>
                <dd data-testid="pickup-loaded-ticket">{loaded.ticket_no}</dd>
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
                    <GarmentCheckRow
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
          <Button variant="ghost" type="button" onClick={onReset} disabled={disabled}>
            清空
          </Button>
        </div>
      </div>

      {result !== null ? (
        <section className="ld-order-result" aria-live="polite">
          <h2 className="ld-order-result__title">取衣结果</h2>
          <dl className="ld-order-result__meta">
            <div>
              <dt>票号</dt>
              <dd data-testid="pickup-ticket">{result.ticket_no}</dd>
            </div>
            <div>
              <dt>订单状态</dt>
              <dd>
                <StatusBadge family="order" status={result.status} />
              </dd>
            </div>
            <div>
              <dt>已付累计</dt>
              <dd>
                <MoneyText fen={result.paid_cents} />
              </dd>
            </div>
            <div>
              <dt>余额</dt>
              <dd>
                <MoneyText fen={result.balance_cents} />
              </dd>
            </div>
            <div>
              <dt>本次取件数</dt>
              <dd>{result.picked_garment_ids.length}</dd>
            </div>
          </dl>
          <ul className="ld-order-result__garments">
            {result.picked_garment_ids.map((id) => (
              <li key={id} className="ld-order-result__garment">
                <span className="ld-order-result__mono">{id}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

type GarmentCheckRowProps = {
  garment: OrderGetGarment;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
};

function GarmentCheckRow({ garment, checked, disabled, onToggle }: GarmentCheckRowProps) {
  const pickable = isPickableGarmentStatus(garment.status);
  const inputId = `pickup-g-${garment.garment_id}`;
  return (
    <li
      className={
        pickable
          ? "ld-pickup-garments__item"
          : "ld-pickup-garments__item ld-pickup-garments__item--disabled"
      }
    >
      <label className="ld-pickup-garments__label" htmlFor={inputId}>
        <input
          id={inputId}
          type="checkbox"
          className="ld-pickup-garments__checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          data-testid={`pickup-garment-${garment.garment_id}`}
        />
        <span className="ld-pickup-garments__body">
          <span className="ld-pickup-garments__barcode">{garment.barcode}</span>
          <span className="ld-pickup-garments__meta-line">
            L{garment.line_index + 1}·#{garment.seq}
          </span>
          <StatusBadge family="garment" status={garment.status} />
          <MoneyText fen={garment.unit_price_cents} />
        </span>
      </label>
    </li>
  );
}
