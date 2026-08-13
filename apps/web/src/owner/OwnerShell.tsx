import { EmptyState } from "@laundry/ui";
import { useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { AiPanelPort } from "../host/ai-port.js";
import { OwnerAiSafetyCard } from "./OwnerAiSafetyCard.js";
import type { ApprovalPort } from "../ai/approval-port.js";
import { ApprovalCenterPage } from "./ApprovalCenterPage.js";
import { OwnerDashboardPage } from "./OwnerDashboardPage.js";
import { OwnerAutomationPage } from "./OwnerAutomationPage.js";
import { OwnerDrilldownPanel } from "./OwnerDrilldownPanel.js";
import { OwnerReportsPage } from "./OwnerReportsPage.js";
import { OwnerMarketingPage } from "./OwnerMarketingPage.js";
import { OwnerStoreManagementPage, type OwnerStoreSelection } from "./OwnerStoreManagementPage.js";
import type { OwnerDrilldownKind } from "./owner-operations-model.js";
import { OwnerPortfolioPanel } from "./OwnerPortfolioPanel.js";

export type OwnerShellProps = Readonly<{
  session: SessionView;
  authClient: AuthClient;
  commandClient: CommandPort;
  queryClient: QueryPort;
  onSessionChange: (session: SessionView | null) => void;
  onSelectStore: (selection: OwnerStoreSelection) => Promise<void>;
  onLogout: () => Promise<void>;
  aiPort?: AiPanelPort;
  approvalPort?: ApprovalPort;
}>;

type OwnerSection = "today" | "reports" | "automation" | "stores" | "marketing" | "approvals";

const OWNER_SECTIONS: readonly Readonly<{ id: OwnerSection; label: string }>[] = Object.freeze([
  Object.freeze({ id: "today", label: "今日经营" }),
  Object.freeze({ id: "reports", label: "经营报表" }),
  Object.freeze({ id: "automation", label: "有界自动化" }),
  Object.freeze({ id: "stores", label: "门店管理" }),
  Object.freeze({ id: "approvals", label: "审批中心" }),
]);

export function OwnerShell({
  session,
  authClient,
  commandClient,
  queryClient,
  onSessionChange,
  onSelectStore,
  onLogout,
  aiPort,
  approvalPort,
}: OwnerShellProps) {
  const allowed = session.role === "admin";
  const marketingEnabled = allowed && session.features.marketing_enabled === true;
  const [loggingOut, setLoggingOut] = useState(false);
  const [drilldownKind, setDrilldownKind] = useState<OwnerDrilldownKind | null>(null);
  const [section, setSection] = useState<OwnerSection>("today");
  const logout = async (): Promise<void> => {
    if (loggingOut) return;
    setLoggingOut(true);
    await onLogout();
  };
  return (
    <div
      className="ld-owner-shell"
      data-shell="owner"
      data-owner-access={allowed ? "allowed" : "denied"}
    >
      <a className="ld-owner-skip" href="#owner-main">
        跳到经营数据
      </a>
      <header className="ld-owner-header">
        <div className="ld-owner-header__identity">
          <span className="ld-owner-header__eyebrow">{session.display.org_code}</span>
          <strong>{session.display.store_name}</strong>
          <span>{session.display.staff_name}</span>
        </div>
        <div className="ld-owner-header__actions">
          <span className="ld-owner-header__badge">云端经营台</span>
          <button
            className="ld-owner-logout"
            type="button"
            disabled={loggingOut}
            onClick={() => void logout()}
          >
            {loggingOut ? "正在退出…" : "退出登录"}
          </button>
        </div>
      </header>
      {allowed ? (
        <nav className="ld-owner-nav" aria-label="店主功能">
          {[
            ...OWNER_SECTIONS,
            ...(marketingEnabled ? [{ id: "marketing" as const, label: "营销活动" }] : []),
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      ) : null}
      <main className="ld-owner-main" id="owner-main" tabIndex={-1}>
        {allowed ? (
          section === "today" ? (
            <>
              <OwnerDashboardPage queryClient={queryClient} onOpenDrilldown={setDrilldownKind} />
              <OwnerDrilldownPanel
                queryClient={queryClient}
                kind={drilldownKind}
                onClose={() => setDrilldownKind(null)}
              />
              <OwnerPortfolioPanel queryClient={queryClient} />
              {aiPort === undefined ? null : (
                <OwnerAiSafetyCard key={session.session.session_id} aiPort={aiPort} />
              )}
            </>
          ) : section === "reports" ? (
            <OwnerReportsPage queryClient={queryClient} commandClient={commandClient} />
          ) : section === "automation" ? (
            <OwnerAutomationPage queryClient={queryClient} commandClient={commandClient} />
          ) : section === "stores" ? (
            <OwnerStoreManagementPage
              session={session}
              authClient={authClient}
              commandClient={commandClient}
              queryClient={queryClient}
              onSessionChange={onSessionChange}
              onSelectStore={onSelectStore}
            />
          ) : section === "marketing" && marketingEnabled ? (
            <OwnerMarketingPage
              session={session}
              authClient={authClient}
              commandClient={commandClient}
              queryClient={queryClient}
            />
          ) : approvalPort === undefined ? (
            <section className="ld-owner-denied lg-card" role="alert">
              <EmptyState title="审批服务不可用" description="当前宿主未提供异步审批能力。" />
            </section>
          ) : (
            <ApprovalCenterPage
              approvalPort={approvalPort}
              currentStaffId={session.session.staff_id}
            />
          )
        ) : (
          <section className="ld-owner-denied lg-card" role="alert">
            <EmptyState
              title="没有查看权限"
              description="当前员工账号没有查看经营看板的权限，请使用店主或管理员账号登录。"
            />
          </section>
        )}
      </main>
      <footer className="ld-owner-footer">
        <span>同源会话保护</span>
        <span aria-hidden>·</span>
        <span>高风险变更需另一位店长现场复核</span>
      </footer>
    </div>
  );
}
