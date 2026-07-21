import { EmptyState, MoneyText, Skeleton, StatusBadge } from "@laundry/ui";
import type { NavItemId } from "../nav.js";
import { pageCopy } from "./page-copy.js";

export type PageHostProps = {
  activeId: NavItemId;
  loading?: boolean;
  onNavigate: (id: NavItemId) => void;
};

function actionTarget(from: NavItemId): NavItemId {
  if (from === "receive") return "settings";
  if (from === "stats" || from === "settings") return "workbench";
  if (from === "workbench") return "receive";
  return from;
}

export function PageHost({ activeId, loading = false, onNavigate }: PageHostProps) {
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
