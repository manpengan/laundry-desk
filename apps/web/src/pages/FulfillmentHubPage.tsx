import { Button } from "@laundry/ui";
import { useState } from "react";

import type { FulfillmentPageProps } from "./FulfillmentPage.js";
import { FactoryHandoffPage } from "./FactoryHandoffPage.js";
import { FulfillmentPage } from "./FulfillmentPage.js";

export function FulfillmentHubPage(props: FulfillmentPageProps) {
  const [view, setView] = useState<"garments" | "factory">("garments");
  return (
    <div className="ld-fulfillment-hub">
      <nav className="ld-fulfillment-hub__tabs" aria-label="生产模块">
        <Button
          type="button"
          variant={view === "garments" ? "primary" : "secondary"}
          onClick={() => setView("garments")}
          aria-pressed={view === "garments"}
        >
          件级生产
        </Button>
        <Button
          type="button"
          variant={view === "factory" ? "primary" : "secondary"}
          onClick={() => setView("factory")}
          aria-pressed={view === "factory"}
        >
          店厂交接
        </Button>
      </nav>
      {view === "garments" ? <FulfillmentPage {...props} /> : <FactoryHandoffPage {...props} />}
    </div>
  );
}
