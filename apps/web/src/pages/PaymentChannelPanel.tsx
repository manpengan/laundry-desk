import { useState } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { PaymentChannelPort } from "../host/payment-channel-port.js";
import { PaymentChannelCollection } from "./PaymentChannelCollection.js";
import { PaymentChannelReconcile } from "./PaymentChannelReconcile.js";
import { PaymentChannelSettings } from "./PaymentChannelSettings.js";
export function PaymentChannelPanel(
  props: Readonly<{
    port: PaymentChannelPort;
    authClient: AuthClient;
    commandClient: CommandPort;
    queryClient?: QueryPort;
    session: SessionView;
  }>,
) {
  const [tab, setTab] = useState<"collection" | "reconcile" | "settings">("collection");
  return (
    <section aria-label="支付渠道与对账" className="space-y-4">
      <h2>支付渠道与对账</h2>
      <nav className="flex flex-wrap gap-2" aria-label="支付操作">
        {(
          [
            { key: "collection", label: "收款与退款" },
            { key: "reconcile", label: "账单核对" },
            { key: "settings", label: "商户设置" },
          ] as const
        ).map((item) => (
          <button
            type="button"
            key={item.key}
            aria-pressed={tab === item.key}
            onClick={() => setTab(item.key)}
            className="rounded border px-3 py-2"
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div hidden={tab !== "collection"}>
        <PaymentChannelCollection {...props} />
      </div>
      {tab === "settings" && <PaymentChannelSettings port={props.port} />}
      {tab === "reconcile" && <PaymentChannelReconcile port={props.port} />}
    </section>
  );
}
