import { MoneyText } from "@laundry/ui";

import {
  ACCOUNTING_METHODS,
  type AccountingMethod,
  type AccountingReportView as AccountingReportValue,
} from "./accounting-report-model.js";

const METHOD_LABELS: Readonly<Record<AccountingMethod, string>> = Object.freeze({
  cash: "现金",
  wechat: "微信",
  alipay: "支付宝",
  other: "其他",
  balance: "会员余额",
});

export function AccountingReportView({ report }: Readonly<{ report: AccountingReportValue }>) {
  return (
    <div className="ld-accounting__result" data-testid="accounting-report-result">
      <p className="ld-accounting__period">
        营业日 {report.date_from} 至 {report.date_to} · {report.totals.ledger_row_count} 笔账本流水
      </p>
      <div className="ld-stats-grid">
        <Metric
          label="实收"
          cents={report.totals.real_income_cents}
          foot="非余额订单净收 + 充值/退款本金"
        />
        <Metric
          label="业绩"
          cents={report.totals.performance_income_cents}
          foot="全部订单消费净额，含会员余额"
        />
        <Metric
          label="会员本金现金流"
          cents={report.totals.stored_value_cashflow_cents}
          foot="充值为正、退款为负，不含赠送"
        />
        <Metric
          label="会员余额消费"
          cents={report.totals.stored_value_consumption_cents}
          foot="计入业绩，不重复计入实收"
        />
      </div>

      <ReportTable
        title={report.group_by === "staff" ? "职员汇总" : "营业日汇总"}
        report={report}
      />

      <section className="ld-accounting__table-section" aria-label="渠道汇总">
        <h3>渠道汇总</h3>
        <div className="ld-accounting__table-wrap">
          <table>
            <thead>
              <tr>
                <th>渠道</th>
                <th>实收</th>
                <th>业绩</th>
                <th>订单净额</th>
                <th>会员本金现金流</th>
                <th>笔数</th>
              </tr>
            </thead>
            <tbody>
              {ACCOUNTING_METHODS.map((method) => {
                const row = report.channels.find((item) => item.method === method);
                if (row === undefined) return null;
                return (
                  <tr key={method}>
                    <td>{METHOD_LABELS[method]}</td>
                    <td>
                      <MoneyText fen={row.real_income_cents} size="sm" />
                    </td>
                    <td>
                      <MoneyText fen={row.performance_income_cents} size="sm" />
                    </td>
                    <td>
                      <MoneyText fen={row.order_income_cents} size="sm" />
                    </td>
                    <td>
                      <MoneyText fen={row.stored_value_cashflow_cents} size="sm" />
                    </td>
                    <td>{row.ledger_row_count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Metric(props: Readonly<{ label: string; cents: number; foot: string }>) {
  return (
    <article className="ld-stats-card">
      <div className="ld-stats-card__label">{props.label}</div>
      <div className="ld-stats-card__value">
        <MoneyText fen={props.cents} size="lg" />
      </div>
      <div className="ld-stats-card__foot">{props.foot}</div>
    </article>
  );
}

function ReportTable(props: Readonly<{ title: string; report: AccountingReportValue }>) {
  return (
    <section className="ld-accounting__table-section" aria-label={props.title}>
      <h3>{props.title}</h3>
      {props.report.rows.length === 0 ? (
        <p>该范围暂无账目流水。</p>
      ) : (
        <div className="ld-accounting__table-wrap">
          <table>
            <thead>
              <tr>
                <th>{props.report.group_by === "staff" ? "职员" : "营业日"}</th>
                <th>实收</th>
                <th>业绩</th>
                <th>会员本金现金流</th>
                <th>会员余额消费</th>
                <th>笔数</th>
              </tr>
            </thead>
            <tbody>
              {props.report.rows.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td>
                    <MoneyText fen={row.real_income_cents} size="sm" />
                  </td>
                  <td>
                    <MoneyText fen={row.performance_income_cents} size="sm" />
                  </td>
                  <td>
                    <MoneyText fen={row.stored_value_cashflow_cents} size="sm" />
                  </td>
                  <td>
                    <MoneyText fen={row.stored_value_consumption_cents} size="sm" />
                  </td>
                  <td>{row.ledger_row_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
