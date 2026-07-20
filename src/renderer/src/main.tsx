import React from "react";
import ReactDOM from "react-dom/client";
import { AppRouter } from "./routes";
import { installWebApiIfNeeded } from "./lib/webApi";
import { installLiquidGlass } from "./lib/liquidGlass";
import "./assets/main.css";

installWebApiIfNeeded();
installLiquidGlass();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>,
);
