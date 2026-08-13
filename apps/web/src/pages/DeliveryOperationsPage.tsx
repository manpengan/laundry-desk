import { useState } from "react";

import type { DeliveryOrdersPageProps } from "./DeliveryOrdersPage.js";
import { DeliveryOrdersPage } from "./DeliveryOrdersPage.js";
import { DeliveryTasksPanel } from "./DeliveryTasksPanel.js";

type DeliveryOperationTab = "orders" | "tasks";

export function DeliveryOperationsPage(props: DeliveryOrdersPageProps) {
  const [tab, setTab] = useState<DeliveryOperationTab>("orders");
  return (
    <div className="ld-delivery-operations">
      <nav className="ld-delivery-operations__tabs" aria-label="取送运营视图">
        <button
          type="button"
          aria-current={tab === "orders" ? "page" : undefined}
          onClick={() => setTab("orders")}
        >
          权威订单
        </button>
        <button
          type="button"
          aria-current={tab === "tasks" ? "page" : undefined}
          onClick={() => setTab("tasks")}
        >
          配送任务
        </button>
      </nav>
      {tab === "orders" ? <DeliveryOrdersPage {...props} /> : <DeliveryTasksPanel {...props} />}
    </div>
  );
}
