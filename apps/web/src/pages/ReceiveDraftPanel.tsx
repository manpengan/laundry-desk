import { Button, MoneyText } from "@laundry/ui";

import type { OrderListRowView } from "./OrdersList.js";

export type ReceiveDraftPanelProps = Readonly<{
  rows: readonly OrderListRowView[];
  loading: boolean;
  busy: boolean;
  activeDraftId: string | null;
  onRefresh: () => void;
  onResume: (orderId: string) => void;
}>;

export function ReceiveDraftPanel({
  rows,
  loading,
  busy,
  activeDraftId,
  onRefresh,
  onResume,
}: ReceiveDraftPanelProps) {
  return (
    <section className="ld-counter-panel ld-counter-drafts" aria-label="未完成挂单">
      <div className="ld-counter-panel__head">
        <h2 className="ld-counter-panel__title">未完成挂单</h2>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={onRefresh}
          disabled={loading || busy}
        >
          {loading ? "刷新中…" : "刷新"}
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="ld-counter-panel__hint">暂无可恢复挂单</p>
      ) : (
        <ul className="ld-counter-draft-list" data-testid="receive-draft-list">
          {rows.map((row) => (
            <li key={row.order_id} data-testid="receive-draft-row">
              <span>
                {row.customer_name ?? "散客挂单"}
                {row.customer_phone === null ? "" : ` · ${row.customer_phone}`}
              </span>
              <span>
                应收 <MoneyText fen={row.payable_cents} size="sm" />
              </span>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => onResume(row.order_id)}
                disabled={busy || row.order_id === activeDraftId}
                data-testid="receive-draft-resume"
              >
                {row.order_id === activeDraftId ? "当前挂单" : "恢复编辑"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
