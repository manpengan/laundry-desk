import { MoneyText } from "@laundry/ui";
import type { ReactNode } from "react";

import type { ReconciliationView } from "./reconciliation-view.js";

const METHOD_LABELS = Object.freeze({
  cash: "现金",
  wechat: "微信",
  alipay: "支付宝",
  other: "其他",
  balance: "会员余额",
});
const KIND_LABELS = Object.freeze({
  pay: "收款",
  repay: "补款",
  refund: "退款",
  storage_fee: "保管费",
  reversal: "冲正",
});
const PRINT_LABELS = Object.freeze({
  queued: "排队",
  printing: "打印中",
  done: "软件完成",
  failed: "失败",
  uncertain: "结果待确认",
});
const REPLAY_LABELS = Object.freeze({
  applied: "已应用",
  duplicate: "重复",
  arbitration: "仲裁应用",
  collision: "冲突",
  rejected: "拒绝",
});

export type ReconciliationSnapshotProps = Readonly<{ value: ReconciliationView }>;

export function ReconciliationSnapshot({ value }: ReconciliationSnapshotProps) {
  return (
    <section
      className="ld-reconciliation"
      data-testid="reconciliation-snapshot"
      data-business-date={value.business_date}
      aria-label="营业日对账快照"
    >
      <header className="ld-reconciliation__header">
        <div>
          <h2>营业日权威快照</h2>
          <p>
            生成于 <time dateTime={value.generated_at}>{value.generated_at}</time>
          </p>
        </div>
        <span
          className={
            value.ledger.difference_from_orders_cents === 0
              ? "ld-reconciliation__balanced"
              : "ld-reconciliation__mismatch"
          }
          role="status"
        >
          {value.ledger.difference_from_orders_cents === 0 ? "当日口径一致" : "存在跨日或账务差异"}
        </span>
      </header>

      <div className="ld-stats-grid">
        <EvidenceCard label="订单" value={String(value.orders.count)} />
        <EvidenceCard
          label="应收"
          value={<MoneyText fen={value.orders.payable_cents} size="lg" />}
        />
        <EvidenceCard
          label="订单已收"
          value={<MoneyText fen={value.orders.paid_cents} size="lg" />}
        />
        <EvidenceCard
          label="订单余额"
          value={<MoneyText fen={value.orders.balance_cents} size="lg" />}
        />
        <EvidenceCard
          label="账本净额"
          value={<MoneyText fen={value.ledger.net_cents} size="lg" />}
        />
        <EvidenceCard
          label="流水－订单已收"
          value={<MoneyText fen={value.ledger.difference_from_orders_cents} size="lg" />}
        />
      </div>

      <section className="ld-reconciliation__section" aria-label="支付账本">
        <h3>支付账本</h3>
        <p>
          共 {value.ledger.row_count} 笔；正向{" "}
          <MoneyText fen={value.ledger.gross_cents} size="sm" />
          ，退款 <MoneyText fen={value.ledger.refund_cents} size="sm" />。
        </p>
        <p>该差额用于诊断；跨日补款、退款与冲正可能形成合理差异。</p>
        {value.ledger.buckets.length === 0 ? (
          <p>该营业日暂无支付流水。</p>
        ) : (
          <div className="ld-reconciliation-table-wrap">
            <table className="ld-reconciliation-table">
              <thead>
                <tr>
                  <th scope="col">渠道</th>
                  <th scope="col">类型</th>
                  <th scope="col">笔数</th>
                  <th scope="col">原额</th>
                  <th scope="col">净额</th>
                </tr>
              </thead>
              <tbody>
                {value.ledger.buckets.map((bucket) => (
                  <tr key={`${bucket.method}:${bucket.kind}`}>
                    <td>{METHOD_LABELS[bucket.method]}</td>
                    <td>{KIND_LABELS[bucket.kind]}</td>
                    <td>{bucket.row_count}</td>
                    <td>
                      <MoneyText fen={bucket.amount_cents} size="sm" />
                    </td>
                    <td>
                      <MoneyText fen={bucket.net_cents} size="sm" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="ld-reconciliation__evidence-grid">
        <section className="ld-reconciliation__section" aria-label="交班证据">
          <h3>交班</h3>
          {value.shift === null ? (
            <p>尚未交班。</p>
          ) : (
            <>
              <p>
                已于 <time dateTime={value.shift.closed_at}>{value.shift.closed_at}</time> 关闭。
              </p>
              <p>
                现金差额 <MoneyText fen={value.shift.cash_difference_cents} size="sm" />
              </p>
            </>
          )}
        </section>
        <CountEvidence
          title="打印（软件状态）"
          total={value.print.total}
          rows={value.print.statuses.map((row) =>
            Object.freeze({ label: PRINT_LABELS[row.status], count: row.count }),
          )}
          empty="暂无打印任务。"
        />
        <CountEvidence
          title="离线回放"
          total={value.edge_replay.total}
          rows={value.edge_replay.decisions.map((row) =>
            Object.freeze({ label: REPLAY_LABELS[row.decision], count: row.count }),
          )}
          empty="暂无服务端回放记录。"
          foot={`需处理 ${value.edge_replay.conflict_count} 项`}
        />
      </div>
    </section>
  );
}

function EvidenceCard(props: Readonly<{ label: string; value: ReactNode }>) {
  return (
    <article className="ld-stats-card">
      <div className="ld-stats-card__label">{props.label}</div>
      <div className="ld-stats-card__value">{props.value}</div>
    </article>
  );
}

function CountEvidence(
  props: Readonly<{
    title: string;
    total: number;
    rows: readonly Readonly<{ label: string; count: number }>[];
    empty: string;
    foot?: string;
  }>,
) {
  return (
    <section className="ld-reconciliation__section" aria-label={props.title}>
      <h3>{props.title}</h3>
      <p>共 {props.total} 项。</p>
      {props.rows.length === 0 ? (
        <p>{props.empty}</p>
      ) : (
        <ul className="ld-reconciliation-counts">
          {props.rows.map((row) => (
            <li key={row.label}>
              <span>{row.label}</span>
              <strong>{row.count}</strong>
            </li>
          ))}
        </ul>
      )}
      {props.foot === undefined ? null : <p>{props.foot}</p>}
    </section>
  );
}
