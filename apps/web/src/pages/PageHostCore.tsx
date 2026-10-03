import { EmptyState, Skeleton } from "@laundry/ui";
import { useState, type ComponentType } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { OfflinePort } from "../host/offline-port.js";
import type { PhotoPort } from "../host/photo-port.js";
import type { PrinterPort } from "../host/printer-port.js";
import type { AiSettingsPort } from "../ai/settings-port.js";
import type { StoreExportPort } from "../host/store-export-port.js";
import type { MigrationPort } from "../host/migration-port.js";
import type { NotificationSettingsPort } from "../host/notification-settings-port.js";
import type { NavItemId } from "../nav.js";
import type { CounterWorkbenchProps } from "./CounterWorkbench.js";
import type { CustomersPageProps } from "./CustomersPage.js";
import type { DebtPageProps } from "./DebtPage.js";
import type { DeliveryOrdersPageProps } from "./DeliveryOrdersPage.js";
import type { FulfillmentPageProps } from "./FulfillmentPage.js";
import { pageCopy } from "./page-copy.js";
import type { PickupPageProps } from "./PickupPage.js";
import type { PickupRemindersPageProps } from "./PickupRemindersPage.js";
import type { ReceivePageProps } from "./ReceivePage.js";
import type { SettingsPageProps } from "./SettingsPage.js";
import type { StatsPageProps } from "./StatsPage.js";

/** Shell-level "open this page with that lookup" request (command palette). */
export type NavigationIntentInput =
  | Readonly<{ kind: "pickup-lookup"; key: string }>
  | Readonly<{ kind: "customer-search"; query: string }>;

export type NavigationIntent = NavigationIntentInput & Readonly<{ nonce: number }>;

export type PageHostProps = {
  activeId: NavItemId;
  loading?: boolean;
  onNavigate: (id: NavItemId) => void;
  /** Latest palette lookup; each new nonce reopens the target page with it. */
  intent?: NavigationIntent;
  /** Required for settings R5 step-up demo and M2 order forms. */
  session?: SessionView;
  authClient?: AuthClient;
  commandClient?: CommandPort;
  /** Optional query bus (catalog price list on receive). */
  queryClient?: QueryPort;
  photoPort?: PhotoPort;
  offlinePort?: OfflinePort;
  printerPort?: PrinterPort;
  aiSettingsPort?: AiSettingsPort;
  migrationPort?: MigrationPort;
  storeExportPort?: StoreExportPort;
  notificationSettingsPort?: NotificationSettingsPort;
  onSessionChange?: (session: SessionView | null) => void;
};

export type PageComponentRegistry = Readonly<{
  CounterWorkbench: ComponentType<CounterWorkbenchProps>;
  CustomersPage: ComponentType<CustomersPageProps>;
  DebtPage: ComponentType<DebtPageProps>;
  DeliveryOperationsPage: ComponentType<DeliveryOrdersPageProps>;
  FulfillmentHubPage: ComponentType<FulfillmentPageProps>;
  PickupPage: ComponentType<PickupPageProps>;
  PickupRemindersPage: ComponentType<PickupRemindersPageProps>;
  ReceivePage: ComponentType<ReceivePageProps>;
  SettingsPage: ComponentType<SettingsPageProps>;
  StatsPage: ComponentType<StatsPageProps>;
}>;

type PageHostCoreProps = PageHostProps & Readonly<{ pages: PageComponentRegistry }>;

function actionTarget(from: NavItemId): NavItemId {
  if (from === "receive") return "settings";
  if (from === "pickup") return "receive";
  if (from === "stats" || from === "settings") return "workbench";
  if (from === "reminders") return "workbench";
  if (from === "workbench") return "receive";
  return from;
}

export function hasLocalPrintQueue(printerPort: PrinterPort | undefined): boolean {
  return printerPort !== undefined;
}

export function PageLoadingFallback() {
  return (
    <main className="ld-shell-main" aria-busy="true" aria-label="加载中">
      <Skeleton className="ld-skeleton--page-title" />
      <div className="ld-page-loading__body">
        <Skeleton lines={4} />
      </div>
    </main>
  );
}

export function PageHostCore({
  pages,
  activeId,
  loading = false,
  onNavigate,
  session,
  authClient,
  commandClient,
  queryClient,
  photoPort,
  offlinePort,
  printerPort,
  aiSettingsPort,
  migrationPort,
  storeExportPort,
  notificationSettingsPort,
  onSessionChange,
  intent,
}: PageHostCoreProps) {
  const copy = pageCopy(activeId);
  const [pickupOrderId, setPickupOrderId] = useState<string | undefined>(undefined);
  const [pickupLookupKey, setPickupLookupKey] = useState<string | undefined>(undefined);
  const [customerQuery, setCustomerQuery] = useState<
    Readonly<{ query: string; customerId?: string }> | undefined
  >(undefined);
  // Remount keys: a new lookup must reach a page that may already be open.
  const [pickupMount, setPickupMount] = useState(0);
  const [customerMount, setCustomerMount] = useState(0);
  const [appliedIntent, setAppliedIntent] = useState(0);
  if (intent !== undefined && intent.nonce !== appliedIntent) {
    // Derived state during render: no stale page mount with the old key.
    setAppliedIntent(intent.nonce);
    if (intent.kind === "pickup-lookup") {
      setPickupOrderId(undefined);
      setPickupLookupKey(intent.key);
      setPickupMount((value) => value + 1);
    } else {
      setCustomerQuery(Object.freeze({ query: intent.query }));
      setCustomerMount((value) => value + 1);
    }
  }
  const openPickupOrder = (orderId: string): void => {
    setPickupOrderId(orderId);
    setPickupLookupKey(undefined);
    setPickupMount((value) => value + 1);
    onNavigate("pickup");
  };
  const {
    CounterWorkbench,
    CustomersPage,
    DebtPage,
    DeliveryOperationsPage,
    FulfillmentHubPage,
    PickupPage,
    PickupRemindersPage,
    ReceivePage,
    SettingsPage,
    StatsPage,
  } = pages;

  if (loading) return <PageLoadingFallback />;

  if (activeId === "receive" && session !== undefined && commandClient !== undefined) {
    return (
      <ReceivePage
        commandClient={commandClient}
        role={session.role}
        queuePrintEnabled={hasLocalPrintQueue(printerPort)}
        {...(offlinePort !== undefined ? { offlinePort } : {})}
        {...(queryClient !== undefined ? { queryClient } : {})}
      />
    );
  }

  if (activeId === "pickup" && session !== undefined && commandClient !== undefined) {
    return (
      <PickupPage
        key={`pickup-${pickupMount}`}
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
        {...(offlinePort !== undefined ? { offlinePort } : {})}
      />
    );
  }

  if (
    activeId === "delivery" &&
    session !== undefined &&
    authClient !== undefined &&
    commandClient !== undefined &&
    queryClient !== undefined
  ) {
    return (
      <DeliveryOperationsPage
        queryClient={queryClient}
        commandClient={commandClient}
        authClient={authClient}
        session={session}
      />
    );
  }

  if (
    activeId === "reminders" &&
    session !== undefined &&
    commandClient !== undefined &&
    queryClient !== undefined
  ) {
    return (
      <PickupRemindersPage
        commandClient={commandClient}
        queryClient={queryClient}
        session={session}
        {...(authClient === undefined ? {} : { authClient })}
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
      <FulfillmentHubPage
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
        key={`customers-${customerMount}`}
        queryClient={queryClient}
        commandClient={commandClient}
        {...(authClient === undefined ? {} : { authClient })}
        session={session}
        {...(photoPort === undefined ? {} : { photoPort })}
        {...(customerQuery === undefined ? {} : { initialQuery: customerQuery.query })}
        {...(customerQuery?.customerId === undefined
          ? {}
          : { initialCustomerId: customerQuery.customerId })}
        onOpenPickup={openPickupOrder}
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
        {...(migrationPort === undefined ? {} : { migrationPort })}
        {...(storeExportPort === undefined ? {} : { storeExportPort })}
        {...(notificationSettingsPort === undefined ? {} : { notificationSettingsPort })}
        {...(aiSettingsPort === undefined ? {} : { aiSettingsPort })}
        session={session}
        authClient={authClient}
        commandClient={commandClient}
        {...(queryClient !== undefined ? { queryClient } : {})}
        {...(offlinePort !== undefined ? { offlinePort } : {})}
        {...(printerPort !== undefined ? { printerPort } : {})}
        {...(onSessionChange !== undefined ? { onSessionChange } : {})}
      />
    );
  }

  if (activeId === "orders" && session !== undefined && queryClient !== undefined) {
    return (
      <DebtPage
        queryClient={queryClient}
        memberEnabled={session.features.member_enabled === true}
        {...(commandClient !== undefined ? { commandClient } : {})}
        {...(authClient !== undefined ? { authClient } : {})}
        session={session}
        {...(photoPort !== undefined ? { photoPort } : {})}
        onOpenPickup={openPickupOrder}
      />
    );
  }

  if (activeId === "workbench" && session !== undefined && queryClient !== undefined) {
    return (
      <CounterWorkbench
        queryClient={queryClient}
        onNavigate={onNavigate}
        onOpenPickup={openPickupOrder}
        onOpenPickupLookup={(key) => {
          setPickupOrderId(undefined);
          setPickupLookupKey(key);
          setPickupMount((value) => value + 1);
          onNavigate("pickup");
        }}
        onOpenCustomer={(query, customerId) => {
          setCustomerQuery(
            Object.freeze({ query, ...(customerId === undefined ? {} : { customerId }) }),
          );
          setCustomerMount((value) => value + 1);
          onNavigate("customers");
        }}
      />
    );
  }

  return (
    <main className="ld-shell-main" id="main-content" tabIndex={-1}>
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
