import { useState } from "react";
import { Tabs } from "@laundry/ui";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { OrderDetailDrawer } from "./OrderDetailDrawer.js";
import type { PaymentChannelPort } from "../host/payment-channel-port.js";
import { PaymentChannelCollection } from "./PaymentChannelCollection.js";
import { PaymentChannelReconcile } from "./PaymentChannelReconcile.js";
import { PaymentChannelSettings } from "./PaymentChannelSettings.js";

type PanelTab = "collection" | "reconcile" | "settings";
const TABS = [
  { id: "collection", label: "收款记录与退款" },
  { id: "reconcile", label: "账单核对" },
  { id: "settings", label: "商户设置" },
] as const;

/** ADR-85 r1: collection itself happens at pickup; settings keeps records, refunds and setup. */
export function PaymentChannelPanel(
  props: Readonly<{
    port: PaymentChannelPort;
    authClient: AuthClient;
    commandClient: CommandPort;
    queryClient?: QueryPort;
    session: SessionView;
  }>,
) {
  const [tab, setTab] = useState<PanelTab>("collection");
  const [orderId, setOrderId] = useState<string | null>(null);
  return (
    <section className="ld-settings-section lg-card ld-panel" aria-label="支付渠道与对账">
      <header className="ld-settings-section__head">
        <h2>支付渠道与对账</h2>
        <p>顾客扫码付款在开单或取衣页发起；这里查看收款记录、原路退款、核对商户账单和设置商户。</p>
      </header>
      <Tabs<PanelTab> label="支付操作" items={TABS} value={tab} onChange={setTab} />
      <div hidden={tab !== "collection"}>
        <PaymentChannelCollection {...props} />
      </div>
      {tab === "settings" && <PaymentChannelSettings port={props.port} />}
      {tab === "reconcile" && (
        <PaymentChannelReconcile
          port={props.port}
          {...(props.queryClient ? { onOpenOrder: setOrderId } : {})}
        />
      )}
      {props.queryClient ? (
        <OrderDetailDrawer
          open={orderId !== null}
          orderId={orderId}
          queryClient={props.queryClient}
          commandClient={props.commandClient}
          authClient={props.authClient}
          session={props.session}
          onClose={() => setOrderId(null)}
        />
      ) : null}
    </section>
  );
}
