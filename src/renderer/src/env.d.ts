/// <reference types="vite/client" />
/// <reference types="electron-vite/client" />

import type { LaundryDeskApi } from "../../preload";

declare global {
  interface Window {
    api: LaundryDeskApi;
  }
}
