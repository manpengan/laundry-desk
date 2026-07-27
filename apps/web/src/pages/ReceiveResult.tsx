import { MoneyText, StatusBadge } from "@laundry/ui";

import type { ReceiveOrderResult } from "./order-form.js";

export function ReceiveResult({ result }: { result: ReceiveOrderResult }) {
  return (
    <section className="ld-order-result" aria-live="polite">
      <h2 className="ld-order-result__title">开单结果</h2>
      <dl className="ld-order-result__meta">
        <div>
          <dt>票号</dt>
          <dd data-testid="receive-ticket">{result.ticket_no}</dd>
        </div>
        <div>
          <dt>取件码</dt>
          <dd data-testid="receive-pickup-code">{result.pickup_code}</dd>
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
          <dt>欠款</dt>
          <dd>
            <MoneyText fen={result.balance_cents} />
          </dd>
        </div>
        <div>
          <dt>衣物</dt>
          <dd>{result.garment_count} 件</dd>
        </div>
      </dl>
      <ul className="ld-order-result__garments">
        {result.garments.map((garment) => (
          <li key={garment.garment_id} className="ld-order-result__garment">
            <span className="ld-order-result__mono">{garment.barcode}</span>
            <StatusBadge family="garment" status={garment.status} />
          </li>
        ))}
      </ul>
    </section>
  );
}
