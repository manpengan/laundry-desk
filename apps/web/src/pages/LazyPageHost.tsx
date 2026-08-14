import { lazy, Suspense } from "react";

import { ErrorBoundary, SurfaceFailure } from "../host/SurfaceFailure.js";
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
    <ErrorBoundary
      fallback={
        <SurfaceFailure
          title="页面加载失败"
          description="没有取到这个页面的代码，可能是网络中断或刚发布了新版本。重新加载后重试。"
        />
      }
    >
      <Suspense fallback={<PageLoadingFallback />}>
        <PageHostCore {...props} pages={LAZY_PAGES} />
      </Suspense>
    </ErrorBoundary>
  );
}
