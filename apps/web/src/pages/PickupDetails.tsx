import { MoneyText, StatusBadge } from "@laundry/ui";

import type { OrderGetGarment, PickupOrderResult } from "./order-form.js";

export function PickupGarmentCheckRow({
  garment,
  checked,
  verified,
  disabled,
  onToggle,
}: Readonly<{
  garment: OrderGetGarment;
  checked: boolean;
  verified: boolean;
  disabled: boolean;
  onToggle: () => void;
}>) {
  const pickable =
    garment.status === "received" || garment.status === "ready" || garment.status === "racked";
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
          {garment.rack_zone === null ? null : (
            <span className="ld-pickup-garments__rack">
              货架 {garment.rack_zone}-{garment.rack_slot}
            </span>
          )}
          {garment.status === "racked" ? (
            <span className="ld-pickup-garments__verification">
              {verified ? "已扫码复核" : "待扫码复核"}
            </span>
          ) : null}
          <StatusBadge family="garment" status={garment.status} />
          <MoneyText fen={garment.unit_price_cents} />
        </span>
      </label>
    </li>
  );
}

export function PickupResult({ result }: Readonly<{ result: PickupOrderResult }>) {
  return (
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
  );
}
