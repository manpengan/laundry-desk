import { EmptyState, Skeleton } from "@laundry/ui";
import { useState } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import type { AccessSession } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { NavItemId } from "../nav.js";
import { CustomersPage } from "./CustomersPage.js";
import { OrdersList } from "./OrdersList.js";
import { pageCopy } from "./page-copy.js";
import { PickupPage } from "./PickupPage.js";
import { ReceivePage } from "./ReceivePage.js";
import { SettingsPage } from "./SettingsPage.js";
import { DebtPage } from "./DebtPage.js";
import { StatsPage } from "./StatsPage.js";

export type PageHostProps = {
  activeId: NavItemId;
  loading?: boolean;
  onNavigate: (id: NavItemId) => void;
  /** Required for settings R5 step-up demo and M2 order forms. */
  session?: AccessSession;
  authClient?: AuthClient;
  commandClient?: CommandPort;
  /** Optional query bus (catalog price list on receive). */
  queryClient?: QueryPort;
};

function actionTarget(from: NavItemId): NavItemId {
  if (from === "receive") return "settings";
  if (from === "pickup") return "receive";
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
  queryClient,
}: PageHostProps) {
  const copy = pageCopy(activeId);
  const [pickupOrderId, setPickupOrderId] = useState<string | undefined>(undefined);

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

  if (activeId === "receive" && session !== undefined && commandClient !== undefined) {
    return (
      <ReceivePage
        commandClient={commandClient}
        {...(queryClient !== undefined ? { queryClient } : {})}
      />
    );
  }

  if (activeId === "pickup" && session !== undefined && commandClient !== undefined) {
    return (
      <PickupPage
        commandClient={commandClient}
        {...(queryClient !== undefined ? { queryClient } : {})}
        {...(pickupOrderId !== undefined ? { initialOrderId: pickupOrderId } : {})}
      />
    );
  }

  if (activeId === "stats" && session !== undefined && queryClient !== undefined) {
    return (
      <StatsPage
        queryClient={queryClient}
        session={session}
        {...(commandClient !== undefined ? { commandClient } : {})}
        {...(authClient !== undefined ? { authClient } : {})}
      />
    );
  }

  if (
    activeId === "customers" &&
    session !== undefined &&
    queryClient !== undefined &&
    commandClient !== undefined
  ) {
    return (
      <CustomersPage
        queryClient={queryClient}
        commandClient={commandClient}
        onOpenPickup={(orderId) => {
          setPickupOrderId(orderId);
          onNavigate("pickup");
        }}
      />
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

  if (activeId === "workbench" && session !== undefined && queryClient !== undefined) {
    return (
      <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
        <h1 className="ld-shell-main__title">{copy.title}</h1>
        <p className="ld-shell-main__hint">{copy.emptyDescription}</p>
        <OrdersList
          queryClient={queryClient}
          {...(commandClient !== undefined ? { commandClient } : {})}
          onOpenPickup={(orderId) => {
            setPickupOrderId(orderId);
            onNavigate("pickup");
          }}
        />
        <DebtPage
          queryClient={queryClient}
          onOpenPickup={(orderId) => {
            setPickupOrderId(orderId);
            onNavigate("pickup");
          }}
        />
        <div className="ld-orders-footer">
          <EmptyState
            title={copy.emptyTitle}
            description="也可从侧栏进入开单或取衣。"
            actionLabel={copy.actionLabel}
            onAction={() => onNavigate(actionTarget(activeId))}
          />
        </div>
      </main>
    );
  }

  return (
    <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">{copy.title}</h1>
      <EmptyState
        title={copy.emptyTitle}
        description={copy.emptyDescription}
        actionLabel={copy.actionLabel}
        onAction={() => onNavigate(actionTarget(activeId))}
      />
    </main>
  );
}
