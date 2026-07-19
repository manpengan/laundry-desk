import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          server: resolve("src/main/server.ts"),
        },
      },
    },
    resolve: { alias: { "@main": resolve("src/main"), "@shared": resolve("src/shared") } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve("src/preload/index.ts") } } },
  },
  renderer: {
    resolve: { alias: { "@renderer": resolve("src/renderer/src"), "@shared": resolve("src/shared") } },
    plugins: [react(), tailwindcss()],
  },
});
