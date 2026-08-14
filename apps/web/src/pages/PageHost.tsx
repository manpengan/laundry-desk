import { CounterWorkbench } from "./CounterWorkbench.js";
import { CustomersPage } from "./CustomersPage.js";
import { DebtPage } from "./DebtPage.js";
import { DeliveryOperationsPage } from "./DeliveryOperationsPage.js";
import { FulfillmentHubPage } from "./FulfillmentHubPage.js";
import { PageHostCore, type PageComponentRegistry, type PageHostProps } from "./PageHostCore.js";
import { PickupPage } from "./PickupPage.js";
import { PickupRemindersPage } from "./PickupRemindersPage.js";
import { ReceivePage } from "./ReceivePage.js";
import { SettingsPage } from "./SettingsPage.js";
import { StatsPage } from "./StatsPage.js";

export type { PageHostProps } from "./PageHostCore.js";
export { hasLocalPrintQueue } from "./PageHostCore.js";

const STATIC_PAGES: PageComponentRegistry = Object.freeze({
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
});

/** Synchronous registry retained for SSR unit tests and the public component API. */
export function PageHost(props: PageHostProps) {
  return <PageHostCore {...props} pages={STATIC_PAGES} />;
}
