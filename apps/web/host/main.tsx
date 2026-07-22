/**
 * Browser host entry for local Vite dev (not part of the library export graph).
 */
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { createHttpAuthClient } from "../src/auth/HttpAuthClient.js";
import { createMockConnection } from "../src/connection.js";
import "../src/styles/shell.css";

const apiBaseUrl =
  (import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL ??
  "http://127.0.0.1:8787";

/** LOCAL ONLY — matches server demo seed (memory + PG). */
const LOCAL_DEMO_LOGIN = Object.freeze({
  org_code: "hongfa",
  store_code: "main",
  username: "admin",
  password: "demo",
});

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("#root missing");
}

const authClient = createHttpAuthClient({ apiBaseUrl });

createRoot(rootEl).render(
  <App
    authClient={authClient}
    connection={createMockConnection({ mode: "online" })}
    enableLiquidGlass
    loginInitialForm={LOCAL_DEMO_LOGIN}
  />,
);

// Helpful for manual walkthroughs in the browser console.
if (typeof console !== "undefined") {
  console.info(`[laundry local web] api=${apiBaseUrl} demo=hongfa/main admin/demo PIN=1234`);
}
