import type { CommandPort, QueryPort } from "../commands/types.js";
import { AccountingReportPanel } from "../pages/AccountingReportPanel.js";

export type OwnerReportsPageProps = Readonly<{
  queryClient: QueryPort;
  commandClient: CommandPort;
}>;

export function OwnerReportsPage({ queryClient, commandClient }: OwnerReportsPageProps) {
  return (
    <div className="ld-owner-reports" data-testid="owner-reports">
      <header className="ld-owner-section-heading">
        <span className="ld-owner-dashboard__date">当前登录门店</span>
        <h1>经营报表</h1>
        <p>支持今日、历史区间、月结与职员业绩，并可导出带完整性摘要的 CSV。</p>
      </header>
      <div className="lg-card ld-owner-reports__panel">
        <AccountingReportPanel queryClient={queryClient} commandClient={commandClient} />
      </div>
    </div>
  );
}
