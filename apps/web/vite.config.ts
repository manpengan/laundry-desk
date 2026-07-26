import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Shared SPA build for the local browser and the Electron app:// host. */
export default defineConfig({
  base: "./",
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist-spa",
    emptyOutDir: true,
  },
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
