import { MoneyText, StatusBadge } from "@laundry/ui";

import { garmentName } from "./garment-labels.js";
import type { ReceiveLineDraft, ReceiveOrderResult } from "./order-form.js";
import { discountPolicyLabel, waiverPolicyLabel } from "./order-policy-labels.js";

export function ReceiveResult({
  result,
  lines,
}: {
  result: ReceiveOrderResult;
  lines?: readonly ReceiveLineDraft[] | undefined;
}) {
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
          <dt>折扣</dt>
          <dd>
            −<MoneyText fen={result.discount_cents} />
          </dd>
        </div>
        <div>
          <dt>折扣来源</dt>
          <dd data-testid="receive-discount-source">{discountPolicyLabel(result)}</dd>
        </div>
        <div>
          <dt>运营豁免</dt>
          <dd data-testid="receive-waivers">{waiverPolicyLabel(result)}</dd>
        </div>
        <div>
          <dt>衣物</dt>
          <dd>{result.garment_count} 件</dd>
        </div>
      </dl>
      <ul className="ld-order-result__garments">
        {result.garments.map((garment) => (
          <li key={garment.garment_id} className="ld-order-result__garment">
            <span>
              {lines?.[garment.line_index]?.catalog_name ??
                (lines?.[garment.line_index]
                  ? garmentName(
                      lines[garment.line_index]!.service_code,
                      lines[garment.line_index]!.category_code,
                    )
                  : `第 ${garment.line_index + 1} 行衣物`)}{" "}
              · 第 {garment.seq} 件
            </span>
            <span>{lines?.[garment.line_index]?.garments[garment.seq - 1]?.color}</span>
            <span className="ld-order-result__mono">条码 {garment.barcode}</span>
            <StatusBadge family="garment" status={garment.status} />
          </li>
        ))}
      </ul>
    </section>
  );
}
