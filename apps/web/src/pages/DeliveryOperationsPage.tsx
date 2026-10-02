import { Tabs } from "@laundry/ui";
import { useState } from "react";

import type { DeliveryOrdersPageProps } from "./DeliveryOrdersPage.js";
import { DeliveryOrdersPage } from "./DeliveryOrdersPage.js";
import { DeliveryTasksPanel } from "./DeliveryTasksPanel.js";

type DeliveryOperationTab = "orders" | "tasks";

const TABS = Object.freeze([
  Object.freeze({ id: "orders" as const, label: "取送订单" }),
  Object.freeze({ id: "tasks" as const, label: "配送任务" }),
]);

export function DeliveryOperationsPage(props: DeliveryOrdersPageProps) {
  const [tab, setTab] = useState<DeliveryOperationTab>("orders");
  return (
    <div className="ld-delivery-operations">
      <div className="ld-subnav">
        <Tabs<DeliveryOperationTab>
          label="取送运营视图"
          items={TABS}
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === "orders" ? <DeliveryOrdersPage {...props} /> : <DeliveryTasksPanel {...props} />}
    </div>
  );
}
