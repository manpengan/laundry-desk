/** Shared renderer entry for local Vite and the Electron app://local host. */
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { createMockConnection } from "../src/connection.js";
import { createBrowserPorts } from "../src/host/browser-ports.js";
import { createDesktopPorts, type LaundryDesktopBridge } from "../src/host/desktop-ports.js";
import { selectHost } from "../src/host/select-ports.js";
import { ServiceGate } from "../src/host/ServiceGate.js";
import "@laundry/ui/styles.css";
import "@laundry/ui/styles/components.css";
import "../src/styles/shell.css";

const apiBaseUrl =
  (import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL ??
  "http://127.0.0.1:8787";

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("#root missing");
}

const bridge = (
  window as Window & {
    laundryDesktop?: LaundryDesktopBridge;
  }
).laundryDesktop;
const host = selectHost(window.location.href, bridge);
const ports =
  host.kind === "desktop" ? createDesktopPorts(host.bridge) : createBrowserPorts({ apiBaseUrl });

createRoot(rootEl).render(
  <ServiceGate health={ports.health}>
    <App ports={ports} connection={createMockConnection({ mode: "online" })} enableLiquidGlass />
  </ServiceGate>,
);
