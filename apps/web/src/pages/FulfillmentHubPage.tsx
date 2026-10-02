import { Tabs } from "@laundry/ui";
import { useState } from "react";

import type { FulfillmentPageProps } from "./FulfillmentPage.js";
import { FactoryHandoffPage } from "./FactoryHandoffPage.js";
import { FulfillmentPage } from "./FulfillmentPage.js";

type FulfillmentView = "garments" | "factory";

const TABS = Object.freeze([
  Object.freeze({ id: "garments" as const, label: "件级生产" }),
  Object.freeze({ id: "factory" as const, label: "店厂交接" }),
]);

export function FulfillmentHubPage(props: FulfillmentPageProps) {
  const [view, setView] = useState<FulfillmentView>("garments");
  return (
    <div className="ld-fulfillment-hub">
      <div className="ld-subnav ld-fulfillment-hub__tabs">
        <Tabs<FulfillmentView> label="生产模块" items={TABS} value={view} onChange={setView} />
      </div>
      {view === "garments" ? <FulfillmentPage {...props} /> : <FactoryHandoffPage {...props} />}
    </div>
  );
}
