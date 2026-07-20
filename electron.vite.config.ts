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
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        // 生产构建移除 CSP 里的 localhost 白名单（开发态才需要）
        name: "clean-csp-localhost",
        transformIndexHtml(html) {
          if (process.env.NODE_ENV === "production") {
            return html.replace(
              /connect-src\s+'self'\s+http:\/\/localhost:\*\s+ws:\/\/localhost:\*/g,
              "connect-src 'self'",
            );
          }
          return html;
        },
      },
    ],
  },
});
