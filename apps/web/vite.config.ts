import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function manualChunkFor(moduleId: string): string | undefined {
  const id = moduleId.replaceAll("\\", "/");
  if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/")) {
    return "react-runtime";
  }
  if (id.includes("/node_modules/zod/")) return "validation-runtime";
  if (id.includes("/packages/contracts/")) return "laundry-contracts";
  if (id.includes("/packages/domain/")) return "laundry-domain";
  if (id.includes("/packages/ui/")) return "laundry-ui";
  return undefined;
}

/** Shared SPA build for the local browser and the Electron app:// host. */
export default defineConfig({
  base: "./",
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist-spa",
    emptyOutDir: true,
    rollupOptions: {
      output: { manualChunks: manualChunkFor },
    },
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
