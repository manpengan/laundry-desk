import { Button, MoneyText, StatusBadge } from "@laundry/ui";

import { isPickableGarmentStatus, type OrderGetResult } from "./order-form.js";
import { PickupGarmentCheckRow } from "./PickupDetails.js";
import { PickupVerificationPanel } from "./PickupVerificationPanel.js";

export function PickupOrderPanel({
  order,
  selected,
  verifiedBarcodes,
  verificationBarcode,
  verifiedRequired,
  requiredVerification,
  disabled,
  onSelectAll,
  onSelectNone,
  onToggle,
  onVerificationBarcodeChange,
  onVerify,
}: Readonly<{
  order: OrderGetResult;
  selected: ReadonlySet<string>;
  verifiedBarcodes: ReadonlySet<string>;
  verificationBarcode: string;
  verifiedRequired: number;
  requiredVerification: number;
  disabled: boolean;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onToggle: (garmentId: string) => void;
  onVerificationBarcodeChange: (value: string) => void;
  onVerify: () => void;
}>) {
  const pickable = order.garments.filter((garment) => isPickableGarmentStatus(garment.status));
  return (
    <section className="ld-pickup-order" aria-label="订单摘要">
      <dl className="ld-order-result__meta">
        <div>
          <dt>票号</dt>
          <dd data-testid="pickup-loaded-ticket">{order.ticket_no ?? "挂单"}</dd>
        </div>
        <div>
          <dt>取件码</dt>
          <dd>{order.pickup_code ?? "—"}</dd>
        </div>
        <div>
          <dt>余额</dt>
          <dd data-testid="pickup-loaded-balance">
            <MoneyText fen={order.balance_cents} />
          </dd>
        </div>
        <div>
          <dt>订单状态</dt>
          <dd>
            <StatusBadge family="order" status={order.status} />
          </dd>
        </div>
        <div>
          <dt>已付累计</dt>
          <dd>
            <MoneyText fen={order.paid_cents} />
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
          <p className="ld-pickup-garments__empty">没有可取衣物</p>
        ) : (
          <ul className="ld-pickup-garments__list" data-testid="pickup-garment-list">
            {order.garments.map((garment) => (
              <PickupGarmentCheckRow
                key={garment.garment_id}
                garment={garment}
                checked={selected.has(garment.garment_id)}
                verified={verifiedBarcodes.has(garment.barcode.toUpperCase())}
                disabled={disabled || !isPickableGarmentStatus(garment.status)}
                onToggle={() => onToggle(garment.garment_id)}
              />
            ))}
          </ul>
        )}
        <p className="ld-pickup-garments__meta">
          已选 {selected.size} / 可取 {pickable.length}
        </p>
      </div>
      <PickupVerificationPanel
        barcode={verificationBarcode}
        verified={verifiedRequired}
        required={requiredVerification}
        disabled={disabled}
        onBarcodeChange={onVerificationBarcodeChange}
        onVerify={onVerify}
      />
    </section>
  );
}
