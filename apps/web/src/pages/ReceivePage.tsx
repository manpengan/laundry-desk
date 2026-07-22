/**
 * 开单（order.receive）— M2 counter form over command bus.
 */

import { Button, Input, MoneyText, StatusBadge, useToast } from "@laundry/ui";
import { useCallback, useState } from "react";
import type { CommandPort } from "../commands/types.js";
import {
  buildReceiveBody,
  newLineDraft,
  unwrapCommandResult,
  type ReceiveLineDraft,
  type ReceiveOrderResult,
} from "./order-form.js";

export type ReceivePageProps = {
  commandClient: CommandPort;
};

function updateLine(
  lines: readonly ReceiveLineDraft[],
  key: string,
  patch: Partial<ReceiveLineDraft>,
): ReceiveLineDraft[] {
  return lines.map((line) =>
    line.key === key ? Object.freeze({ ...line, ...patch, key: line.key }) : line,
  );
}

export function ReceivePage({ commandClient }: ReceivePageProps) {
  const toast = useToast();
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [paidText, setPaidText] = useState("0");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<readonly ReceiveLineDraft[]>(() => [newLineDraft(0)]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReceiveOrderResult | null>(null);

  const onAddLine = useCallback(() => {
    setLines((prev) => [...prev, newLineDraft(prev.length)]);
  }, []);

  const onRemoveLine = useCallback((key: string) => {
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((line) => line.key !== key)));
  }, []);

  const onSubmit = useCallback(async () => {
    const built = buildReceiveBody({
      customer_phone: phone,
      customer_name: name,
      paid_cents: paidText,
      note,
      lines,
    });
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
      setResult(payload);
      toast.push(`开单成功 ${payload.ticket_no}`, "success");
    } finally {
      setBusy(false);
    }
  }, [commandClient, lines, name, note, paidText, phone, toast]);

  const onReset = useCallback(() => {
    setPhone("");
    setName("");
    setPaidText("0");
    setNote("");
    setLines([newLineDraft(0)]);
    setResult(null);
  }, []);

  return (
    <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">开单</h1>
      <p className="ld-shell-main__hint">
        创建订单与衣物件（整数分）。可选手机号建档；提交后显示票号与条码。
      </p>

      <div className="ld-order-form">
        <div className="ld-order-form__row">
          <Input
            name="customer-phone"
            label="手机号（可选）"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            hint="11 位 1[3-9]…；种子 13800000xxx"
            disabled={busy}
          />
          <Input
            name="customer-name"
            label="客户姓名（可选）"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
        </div>

        <fieldset className="ld-order-form__lines" disabled={busy}>
          <legend className="ld-order-form__legend">衣物明细</legend>
          {lines.map((line, index) => (
            <div className="ld-order-form__line" key={line.key}>
              <span className="ld-order-form__line-index">#{index + 1}</span>
              <Input
                name={`service-${line.key}`}
                label="服务"
                value={line.service_code}
                onChange={(event) =>
                  setLines((prev) =>
                    updateLine(prev, line.key, { service_code: event.target.value }),
                  )
                }
              />
              <Input
                name={`category-${line.key}`}
                label="品类"
                value={line.category_code}
                onChange={(event) =>
                  setLines((prev) =>
                    updateLine(prev, line.key, { category_code: event.target.value }),
                  )
                }
              />
              <Input
                name={`price-${line.key}`}
                label="单价（分）"
                inputMode="numeric"
                value={line.unit_price_cents}
                onChange={(event) =>
                  setLines((prev) =>
                    updateLine(prev, line.key, { unit_price_cents: event.target.value }),
                  )
                }
                hint="如 1500 = ¥15.00"
              />
              <Input
                name={`qty-${line.key}`}
                label="数量"
                inputMode="numeric"
                value={line.qty}
                onChange={(event) =>
                  setLines((prev) => updateLine(prev, line.key, { qty: event.target.value }))
                }
              />
              <Button
                variant="ghost"
                type="button"
                size="sm"
                onClick={() => onRemoveLine(line.key)}
                disabled={lines.length <= 1 || busy}
              >
                删除
              </Button>
            </div>
          ))}
          <div className="ld-order-form__line-actions">
            <Button variant="secondary" type="button" onClick={onAddLine} disabled={busy}>
              添加一行
            </Button>
          </div>
        </fieldset>

        <div className="ld-order-form__row">
          <Input
            name="paid-cents"
            label="已付（分）"
            inputMode="numeric"
            value={paidText}
            onChange={(event) => setPaidText(event.target.value)}
            hint="定金/部分付款，整数分，默认 0"
            disabled={busy}
          />
          <Input
            name="note"
            label="备注（可选）"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={busy}
          />
        </div>

        <div className="ld-order-form__actions">
          <Button variant="primary" type="button" onClick={() => void onSubmit()} disabled={busy}>
            {busy ? "提交中…" : "确认开单"}
          </Button>
          <Button variant="ghost" type="button" onClick={onReset} disabled={busy}>
            清空
          </Button>
        </div>
      </div>

      {result !== null ? (
        <section className="ld-order-result" aria-live="polite">
          <h2 className="ld-order-result__title">开单结果</h2>
          <dl className="ld-order-result__meta">
            <div>
              <dt>票号</dt>
              <dd data-testid="receive-ticket">{result.ticket_no}</dd>
            </div>
            <div>
              <dt>订单 ID</dt>
              <dd className="ld-order-result__mono">{result.order_id}</dd>
            </div>
            <div>
              <dt>应付</dt>
              <dd>
                <MoneyText fen={result.payable_cents} />
              </dd>
            </div>
            <div>
              <dt>已付</dt>
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
              <dt>件数</dt>
              <dd>{result.garment_count}</dd>
            </div>
          </dl>
          <ul className="ld-order-result__garments">
            {result.garments.map((g) => (
              <li key={g.garment_id} className="ld-order-result__garment">
                <span className="ld-order-result__mono">{g.barcode}</span>
                <StatusBadge family="garment" status={g.status} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
