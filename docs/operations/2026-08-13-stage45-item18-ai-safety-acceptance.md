# Stage 4.5 Item 18 — AI safety, metering, and degradation acceptance

- 日期：2026-08-13
- 基线：`b729cc3b1a3f1f40d78b3edc391f3feb4c51d67d`
- 分支：`codex/stage45-item18-ai-safety`

## 已验收范围

- 0066 以整数 token 和 cost micros 保存逐 turn 账本及日聚合；组织月预算使用 advisory lock 与未释放
  reservation 原子判断。旧 0065 create/start/finish 执行权已从 app role 撤销，不能绕过安全 wrapper。
- 缺失、关闭或零额度策略按 hard-off 处理；连续 provider failure 持久打开组织熔断器，预算与熔断拒绝
  均不调用 provider，只返回固定 `AI_UNAVAILABLE` 并留下 metadata-only 安全事件。
- 用户输入、跨 chunk 输出与 tool payload 在持久化或转交 provider 前遮蔽 PII；中英文 prompt-injection
  红队命中会在 turn 创建前拒绝，仅保存脱敏内容 SHA-256 和固定 reason。
- SSRF 验证只接受 allowlist 中的 ASCII hostname、HTTPS 443、无 userinfo/fragment/IP literal；空、混合、
  私网、metadata、mapped IPv4 与非 global-unicast DNS 结果全部拒绝。
- Owner 只读 HTTP/UI 显示当前月整数 token/cost、限额、熔断和固定隐私/出口策略；普通 staff 无权读取。
  默认 runtime 无 provider，仍为 hard-off。

## 新鲜 focused 证据

```bash
pnpm --filter @laundry/contracts build
node --experimental-strip-types packages/contracts/scripts/generate-openapi.ts
pnpm --filter @laundry/contracts exec vitest run \
  test/ai-streaming-contract.test.ts test/openapi-snapshot.test.ts

pnpm --filter @laundry/db build
pnpm --filter @laundry/db exec vitest run \
  test/ai-safety-migration.test.ts test/ai-streaming-migration.test.ts \
  test/migration-files.test.ts test/destructive-migration.test.ts

pnpm --filter @laundry/domain build
pnpm --filter @laundry/server build
node --test --test-concurrency=1 \
  apps/server/dist/ai/safety-guard.test.js \
  apps/server/dist/ai/safety-service.test.js \
  apps/server/dist/ai/streaming-rate-limit.test.js \
  apps/server/dist/ai/streaming-service.test.js \
  apps/server/dist/http/ai-streaming-routes.test.js

pnpm --filter @laundry/ui build
pnpm --filter @laundry/web build
node --test \
  apps/web/dist/host/ai-port.test.js \
  apps/web/dist/owner/owner-ai-safety.test.js \
  apps/web/dist/shell/ai-panel.test.js
```

结果：Contracts 9/9、DB 46/46、Server 23/23、Web 6/6 通过；相关 package build/type、changed-file
ESLint、Prettier、OpenAPI snapshot、文件规模、provider-network import scan 与 `git diff --check` 通过。

隔离 PostgreSQL 16 首次从当前基线现有连续迁移 0001–0053、0065、0066 全部应用成功；随后验收 SQL
因测试变量误用 PostgreSQL 保留字 `authorization` 停止，产品迁移未失败，容器已清理。修正测试变量后，
聚焦 0001–0003、0065、0066 重跑缺省预算拒绝、整数账本、三次失败熔断、Prompt Injection 证据、旧函数
撤权、app 无直接 DML 与 FORCE RLS，输出 `AI_0066_REAL_PG_OK`，容器再次清理。

## 明确边界

- 本 Item 没有调用外部网络、真实 AI API、真实 key、provider SDK 或 Item 13 adapter；测试 provider 仍是
  Item 14 的 deterministic fake。
- SSRF helper 要求每个 redirect hop 重新验证，并只连接返回的固定地址；本 Item 不实现任何网络 client。
- 当前隔离基线缺少集成分支 0054–0063，且 0064 依赖该缺口；发布时必须在完整连续 0054–0066 上重跑
  migration、RLS、backup/restore 与部署门禁。本次 focused PG 不替代该集成验收。
