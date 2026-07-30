import { EmptyState, Skeleton } from "@laundry/ui";
import { useState } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { PhotoPort } from "../host/photo-port.js";
import type { NavItemId } from "../nav.js";
import { CustomersPage } from "./CustomersPage.js";
import { DebtPage } from "./DebtPage.js";
import { CounterWorkbench } from "./CounterWorkbench.js";
import { pageCopy } from "./page-copy.js";
import { PickupPage } from "./PickupPage.js";
import { ReceivePage } from "./ReceivePage.js";
import { SettingsPage } from "./SettingsPage.js";
import { StatsPage } from "./StatsPage.js";
import { FulfillmentPage } from "./FulfillmentPage.js";

export type PageHostProps = {
  activeId: NavItemId;
  loading?: boolean;
  onNavigate: (id: NavItemId) => void;
  /** Required for settings R5 step-up demo and M2 order forms. */
  session?: SessionView;
  authClient?: AuthClient;
  commandClient?: CommandPort;
  /** Optional query bus (catalog price list on receive). */
  queryClient?: QueryPort;
  photoPort?: PhotoPort;
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
  photoPort,
}: PageHostProps) {
  const copy = pageCopy(activeId);
  const [pickupOrderId, setPickupOrderId] = useState<string | undefined>(undefined);
  const [pickupLookupKey, setPickupLookupKey] = useState<string | undefined>(undefined);

  if (loading) {
    return (
      <main className="ld-shell-main lg-card" aria-busy="true" aria-label="加载中">
        <Skeleton className="ld-skeleton--page-title" />
        <div className="ld-page-loading__body">
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
        {...(pickupLookupKey !== undefined ? { initialLookupKey: pickupLookupKey } : {})}
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
    activeId === "fulfillment" &&
    session !== undefined &&
    authClient !== undefined &&
    commandClient !== undefined &&
    queryClient !== undefined
  ) {
    return (
      <FulfillmentPage
        queryClient={queryClient}
        commandClient={commandClient}
        authClient={authClient}
        session={session}
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
        {...(authClient === undefined ? {} : { authClient })}
        session={session}
        {...(photoPort === undefined ? {} : { photoPort })}
        onOpenPickup={(orderId) => {
          setPickupOrderId(orderId);
          setPickupLookupKey(undefined);
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
    return (
      <SettingsPage
        session={session}
        authClient={authClient}
        commandClient={commandClient}
        {...(queryClient !== undefined ? { queryClient } : {})}
      />
    );
  }

  // Product design §5.1 lists 订单与欠款 as a first-phase navigation entry; it
  // is the only route that reaches the order detail drawer.
  if (activeId === "orders" && session !== undefined && queryClient !== undefined) {
    return (
      <DebtPage
        queryClient={queryClient}
        {...(commandClient !== undefined ? { commandClient } : {})}
        {...(photoPort !== undefined ? { photoPort } : {})}
        onOpenPickup={(orderId) => {
          setPickupOrderId(orderId);
          setPickupLookupKey(undefined);
          onNavigate("pickup");
        }}
      />
    );
  }

  if (activeId === "workbench" && session !== undefined && queryClient !== undefined) {
    return (
      <CounterWorkbench
        queryClient={queryClient}
        onNavigate={onNavigate}
        onOpenPickup={(orderId) => {
          setPickupOrderId(orderId);
          setPickupLookupKey(undefined);
          onNavigate("pickup");
        }}
        onOpenPickupLookup={(key) => {
          setPickupOrderId(undefined);
          setPickupLookupKey(key);
          onNavigate("pickup");
        }}
      />
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
