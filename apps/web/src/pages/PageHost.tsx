import { EmptyState, MoneyText, Skeleton, StatusBadge } from "@laundry/ui";
import type { AuthClient } from "../auth/AuthClient.js";
import type { AccessSession } from "../auth/types.js";
import type { CommandPort } from "../commands/types.js";
import type { NavItemId } from "../nav.js";
import { pageCopy } from "./page-copy.js";
import { SettingsPage } from "./SettingsPage.js";

export type PageHostProps = {
  activeId: NavItemId;
  loading?: boolean;
  onNavigate: (id: NavItemId) => void;
  /** Required for settings R5 step-up demo. */
  session?: AccessSession;
  authClient?: AuthClient;
  commandClient?: CommandPort;
};

function actionTarget(from: NavItemId): NavItemId {
  if (from === "receive") return "settings";
  if (from === "stats" || from === "settings") return "workbench";
  if (from === "workbench") return "receive";
  return from;
}

export function PageHost({
  activeId,
  loading = false,
  onNavigate,
  session,
  authClient,
  commandClient,
}: PageHostProps) {
  const copy = pageCopy(activeId);

  if (loading) {
    return (
      <main className="ld-shell-main lg-card" aria-busy="true" aria-label="加载中">
        <Skeleton height={28} width="40%" />
        <div style={{ marginTop: 16 }}>
          <Skeleton lines={4} />
        </div>
      </main>
    );
  }

  if (
    activeId === "settings" &&
    session !== undefined &&
    authClient !== undefined &&
    commandClient !== undefined
  ) {
    return <SettingsPage session={session} authClient={authClient} commandClient={commandClient} />;
  }

  return (
    <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">{copy.title}</h1>
      {activeId === "workbench" ? (
        <div className="ld-shell-demo-row" style={{ marginBottom: 20 }}>
          <div>
            <div className="ld-shell-demo-label">示例营业额</div>
            <MoneyText fen={0} size="lg" />
          </div>
          <div>
            <div className="ld-shell-demo-label">件状态</div>
            <StatusBadge family="garment" status="ready" />
          </div>
        </div>
      ) : null}
      <EmptyState
        title={copy.emptyTitle}
        description={copy.emptyDescription}
        actionLabel={copy.actionLabel}
        onAction={() => onNavigate(actionTarget(activeId))}
      />
    </main>
  );
}
