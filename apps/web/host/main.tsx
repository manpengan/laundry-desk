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

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("#root missing");
}

const authClient = createHttpAuthClient({ apiBaseUrl });

createRoot(rootEl).render(
  <App authClient={authClient} connection={createMockConnection("online")} enableLiquidGlass />,
);
