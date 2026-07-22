/**
 * 取衣（order.pickup）— M2 counter form over command bus.
 * Empty garment_ids = all pickable on the order.
 */

import { Button, Input, MoneyText, StatusBadge, useToast } from "@laundry/ui";
import { useCallback, useState } from "react";
import type { CommandPort } from "../commands/types.js";
import { buildPickupBody, unwrapCommandResult, type PickupOrderResult } from "./order-form.js";

export type PickupPageProps = {
  commandClient: CommandPort;
};

export function PickupPage({ commandClient }: PickupPageProps) {
  const toast = useToast();
  const [orderId, setOrderId] = useState("");
  const [collectText, setCollectText] = useState("0");
  const [garmentIdsText, setGarmentIdsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PickupOrderResult | null>(null);

  const onSubmit = useCallback(async () => {
    const built = buildPickupBody({
      order_id: orderId,
      collect_cents: collectText,
      garment_ids_text: garmentIdsText,
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
    } finally {
      setBusy(false);
    }
  }, [collectText, commandClient, garmentIdsText, orderId, toast]);

  const onReset = useCallback(() => {
    setOrderId("");
    setCollectText("0");
    setGarmentIdsText("");
    setResult(null);
  }, []);

  return (
    <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">取衣</h1>
      <p className="ld-shell-main__hint">
        按订单 UUID 取件；件 ID 留空表示全部可取件。收款为整数分，结算余额。
      </p>

      <div className="ld-order-form">
        <Input
          name="order-id"
          label="订单 ID"
          value={orderId}
          onChange={(event) => setOrderId(event.target.value)}
          hint="UUID，可从开单结果复制"
          disabled={busy}
        />
        <Input
          name="collect-cents"
          label="本次收款（分）"
          inputMode="numeric"
          value={collectText}
          onChange={(event) => setCollectText(event.target.value)}
          hint="整数分；0 表示不追加收款"
          disabled={busy}
        />
        <Input
          name="garment-ids"
          label="件 ID（可选）"
          value={garmentIdsText}
          onChange={(event) => setGarmentIdsText(event.target.value)}
          hint="逗号/空格分隔 UUID；留空 = 全部可取件"
          disabled={busy}
        />

        <div className="ld-order-form__actions">
          <Button variant="primary" type="button" onClick={() => void onSubmit()} disabled={busy}>
            {busy ? "提交中…" : "确认取衣"}
          </Button>
          <Button variant="ghost" type="button" onClick={onReset} disabled={busy}>
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
