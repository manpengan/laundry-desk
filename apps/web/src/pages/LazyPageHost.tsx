import { lazy, Suspense } from "react";

import {
  PageHostCore,
  PageLoadingFallback,
  type PageComponentRegistry,
  type PageHostProps,
} from "./PageHostCore.js";

const LAZY_PAGES: PageComponentRegistry = Object.freeze({
  CounterWorkbench: lazy(async () => {
    const module = await import("./CounterWorkbench.js");
    return { default: module.CounterWorkbench };
  }),
  CustomersPage: lazy(async () => {
    const module = await import("./CustomersPage.js");
    return { default: module.CustomersPage };
  }),
  DebtPage: lazy(async () => {
    const module = await import("./DebtPage.js");
    return { default: module.DebtPage };
  }),
  DeliveryOperationsPage: lazy(async () => {
    const module = await import("./DeliveryOperationsPage.js");
    return { default: module.DeliveryOperationsPage };
  }),
  FulfillmentHubPage: lazy(async () => {
    const module = await import("./FulfillmentHubPage.js");
    return { default: module.FulfillmentHubPage };
  }),
  PickupPage: lazy(async () => {
    const module = await import("./PickupPage.js");
    return { default: module.PickupPage };
  }),
  PickupRemindersPage: lazy(async () => {
    const module = await import("./PickupRemindersPage.js");
    return { default: module.PickupRemindersPage };
  }),
  ReceivePage: lazy(async () => {
    const module = await import("./ReceivePage.js");
    return { default: module.ReceivePage };
  }),
  SettingsPage: lazy(async () => {
    const module = await import("./SettingsPage.js");
    return { default: module.SettingsPage };
  }),
  StatsPage: lazy(async () => {
    const module = await import("./StatsPage.js");
    return { default: module.StatsPage };
  }),
});

/** Production-only route host: the active counter route is fetched on demand. */
export function LazyPageHost(props: PageHostProps) {
  return (
    <Suspense fallback={<PageLoadingFallback />}>
      <PageHostCore {...props} pages={LAZY_PAGES} />
    </Suspense>
  );
}
