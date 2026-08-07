import { EmptyState } from "@laundry/ui";
import { useState } from "react";

import type { SessionView } from "../auth/types.js";
import type { QueryPort } from "../commands/types.js";
import { OwnerDashboardPage } from "./OwnerDashboardPage.js";
import { OwnerDrilldownPanel } from "./OwnerDrilldownPanel.js";
import type { OwnerDrilldownKind } from "./owner-operations-model.js";
import { OwnerPortfolioPanel } from "./OwnerPortfolioPanel.js";

export type OwnerShellProps = Readonly<{
  session: SessionView;
  queryClient: QueryPort;
  onLogout: () => Promise<void>;
}>;

export function OwnerShell({ session, queryClient, onLogout }: OwnerShellProps) {
  const allowed = session.role === "admin";
  const [loggingOut, setLoggingOut] = useState(false);
  const [drilldownKind, setDrilldownKind] = useState<OwnerDrilldownKind | null>(null);
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
          <span className="ld-owner-header__badge">只读经营看板</span>
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
      <main className="ld-owner-main" id="owner-main" tabIndex={-1}>
        {allowed ? (
          <>
            <OwnerDashboardPage queryClient={queryClient} onOpenDrilldown={setDrilldownKind} />
            <OwnerDrilldownPanel
              queryClient={queryClient}
              kind={drilldownKind}
              onClose={() => setDrilldownKind(null)}
            />
            <OwnerPortfolioPanel queryClient={queryClient} />
          </>
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
        <span>局域网只读</span>
        <span aria-hidden>·</span>
        <span>不提供开单、收款或打印操作</span>
      </footer>
    </div>
  );
}
