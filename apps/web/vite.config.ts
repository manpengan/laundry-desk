import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Local SPA host for M1 testing.
 * Library build remains `tsc` (package scripts); this config is for `pnpm local:web` only.
 */
export default defineConfig({
  plugins: [react()],
  root: ".",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // Optional same-origin proxy if you set VITE_API_BASE_URL=""
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/v1": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
  resolve: {
    // Prefer package source for monorepo DX
    dedupe: ["react", "react-dom"],
  },
});
