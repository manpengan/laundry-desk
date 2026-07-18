import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@main": resolve("src/main"),
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      rollupOptions: {
        external: ["@electron-toolkit/utils"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
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
