import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  // Electron 冷启动在 CI（尤其 Windows runner 负载高时）可能超过默认 5s 断言超时，
  // 曾导致 main 上首个断言 heading 找不到而假红（同一份代码在 PR 上通过）。
  expect: { timeout: 15_000 },
  // CI 上重试 2 次：区分真实回归与启动抖动，本地不重试以便立即暴露问题。
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
});
