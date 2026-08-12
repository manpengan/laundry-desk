import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { CustomerPortalClient } from "./client.js";
import { createCustomerPortalController } from "./controller.js";
import { CustomerPortalLogin } from "./CustomerPortalLogin.js";
import { CustomerPortalOrders } from "./CustomerPortalOrders.js";

export type CustomerPortalAppProps = Readonly<{ client: CustomerPortalClient }>;

export function CustomerPortalApp({ client }: CustomerPortalAppProps) {
  const controller = useMemo(() => createCustomerPortalController(client), [client]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    void controller.resume();
    return controller.dispose;
  }, [controller]);

  if (state.authenticated === null) {
    return (
      <main className="ld-customer-portal">
        <p>正在检查安全会话…</p>
      </main>
    );
  }
  if (!state.authenticated) {
    return <CustomerPortalLogin busy={state.busy} error={state.error} onLogin={controller.login} />;
  }
  return (
    <CustomerPortalOrders
      orders={state.orders}
      selectedOrderId={state.selectedOrderId}
      detail={state.detail}
      progress={state.progress}
      busy={state.busy}
      error={state.error}
      onSelect={(orderId) => void controller.selectOrder(orderId)}
      onProgress={(orderId, garmentId) => void controller.loadProgress(orderId, garmentId)}
      onRefresh={() => void controller.loadOrders()}
      onLogout={() => void controller.logout()}
    />
  );
}
