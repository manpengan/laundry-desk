/** Shared renderer entry for local Vite and the Electron app://local host. */
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { createMockConnection } from "../src/connection.js";
import { appSurfaceFromPathname } from "../src/host/app-surface.js";
import { resolveBrowserApiBaseUrl } from "../src/host/browser-api-base.js";
import { createBrowserPorts } from "../src/host/browser-ports.js";
import { createDesktopPorts, type LaundryDesktopBridge } from "../src/host/desktop-ports.js";
import { selectHost } from "../src/host/select-ports.js";
import { ServiceGate } from "../src/host/ServiceGate.js";
import "@laundry/ui/styles.css";
import "@laundry/ui/styles/components.css";
import "../src/styles/shell.css";
import "../src/styles/delivery-policy.css";
import "../src/styles/delivery-appointments.css";
import "../src/styles/delivery-orders.css";
import "../src/styles/member.css";
import "../src/styles/owner-dashboard.css";
import "../src/styles/owner-operations.css";
import "../src/styles/owner-management.css";
import "../src/styles/staff-credentials.css";
import "../src/styles/printer-settings.css";

const apiBaseUrl = resolveBrowserApiBaseUrl(
  (import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL,
  window.location,
);

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("#root missing");
}
const hostRoot = rootEl;

const bridge = (
  window as Window & {
    laundryDesktop?: LaundryDesktopBridge;
  }
).laundryDesktop;
const host = selectHost(window.location.href, bridge);
const surface =
  host.kind === "browser" ? appSurfaceFromPathname(window.location.pathname) : "counter";
const ports =
  host.kind === "desktop" ? createDesktopPorts(host.bridge) : createBrowserPorts({ apiBaseUrl });

async function start(): Promise<void> {
  const resumed = (await ports.resume?.resume()) ?? Object.freeze({ ok: false as const });
  const readOnly = resumed.ok && resumed.mode === "offline_read_only";
  createRoot(hostRoot).render(
    <ServiceGate health={ports.health}>
      <App
        ports={ports}
        surface={surface}
        connection={createMockConnection({ mode: readOnly ? "offline" : "online" })}
        enableLiquidGlass={host.kind === "browser"}
        initialSession={resumed.ok ? resumed.session : null}
        readOnly={readOnly}
      />
    </ServiceGate>,
  );
}

void start();
