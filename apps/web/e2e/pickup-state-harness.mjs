/** Real React DOM, with controlled ports instead of customer data or authentication. */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "@laundry/ui";
import { PickupPage } from "../src/pages/PickupPage.tsx";
import { createPaymentChannelPort } from "../src/host/payment-channel-port.ts";

function port(kind) {
  return {
    async execute(name, body) {
      const response = await fetch(`/__pickup_state/${kind}/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.json();
    },
  };
}

const channelPort = new URLSearchParams(location.search).has("channels")
  ? createPaymentChannelPort(({ operation, body }) => port("channel").execute(operation, body))
  : undefined;
const root = createRoot(document.getElementById("root"));
export function unmount() {
  root.unmount();
}
root.render(
  createElement(
    ToastProvider,
    null,
    createElement(PickupPage, {
      queryClient: port("query"),
      commandClient: port("command"),
      paymentChannelPort: channelPort,
    }),
  ),
);
