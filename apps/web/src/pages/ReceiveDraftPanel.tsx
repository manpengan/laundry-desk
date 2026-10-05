import { Button, Icon, MaskedPhone, MoneyText } from "@laundry/ui";

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
    <section
      className={
        rows.length === 0 ? "ld-counter-drafts ld-counter-drafts--empty" : "ld-counter-drafts"
      }
      aria-label="未完成挂单"
    >
      <div className="ld-counter-drafts__head">
        <h2 className="ld-counter-drafts__title">
          <Icon name="clock" size={16} />
          未完成挂单
          <span className="ld-counter-drafts__count">{rows.length}</span>
        </h2>
        {rows.length === 0 ? <span className="ld-counter-drafts__none">暂无可恢复挂单</span> : null}
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
      {rows.length === 0 ? null : (
        <details className="ld-counter-drafts__details">
          <summary>查看并恢复挂单（{rows.length}）</summary>
          <ul className="ld-counter-draft-list" data-testid="receive-draft-list">
            {rows.map((row) => (
              <li key={row.order_id} data-testid="receive-draft-row">
                <span className="ld-counter-draft-list__who">
                  {row.customer_name ?? "散客挂单"}
                  {row.customer_phone === null ? null : <MaskedPhone phone={row.customer_phone} />}
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
        </details>
      )}
    </section>
  );
}
