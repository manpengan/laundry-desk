/// <reference types="vite/client" />

interface Window {
  api: import("../../shared/api").LaundryDeskApi;
  laundryEnv?: { mediaBase: string };
}
