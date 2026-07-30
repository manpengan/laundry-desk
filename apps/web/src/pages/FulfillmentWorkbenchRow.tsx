import { FULFILLMENT_STATUS_LABELS, type FulfillmentRowView } from "./fulfillment-model.js";

export function FulfillmentWorkbenchRow({
  row,
  checked,
  onToggle,
}: Readonly<{
  row: FulfillmentRowView;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}>) {
  const rack =
    row.rack_zone === null || row.rack_slot === null
      ? "未上架"
      : `${row.rack_zone}-${row.rack_slot}`;
  return (
    <label className="ld-fulfillment__row">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <span>
        <strong>{row.ticket_no}</strong>
        <small>{row.barcode}</small>
      </span>
      <span>
        {row.service_code} · {row.category_code}
        <small>{[row.color, row.brand].filter(Boolean).join(" · ") || "—"}</small>
      </span>
      <span>
        {row.customer_name ?? "散客"}
        <small>{row.customer_phone_masked ?? "—"}</small>
      </span>
      <span className={`ld-fulfillment__status ld-fulfillment__status--${row.status}`}>
        {FULFILLMENT_STATUS_LABELS[row.status]}
      </span>
      <span data-testid={`fulfillment-rack-${row.garment_id}`}>{rack}</span>
      <span>异常 {row.incident_count}</span>
    </label>
  );
}
