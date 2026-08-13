# Stage 4.5 Item 14 — bounded AI streaming acceptance

日期：2026-08-13
基线：`0a0ee503ee8a6af914ba3c0c78212f372f967a7e`
分支：`codex/stage45-item14-streaming-ai`

## 已验收范围

- Contracts 新增四个专用、鉴权 AI HTTP schema 和 typed SSE event；没有新增普通 command/query 或 AI
  tool 投影。
- Server 默认 hard-off；只有测试显式注入 deterministic fake 才会运行，provider port 无 URL、header、
  key、SDK 或网络能力。
- SSE 使用 no-store/keep-alive、持久 cursor、有界 replay、断连 abort、背压 drain 和安全 terminal event。
- Loop 限制 4 tool steps、1 秒单 tool timeout、15 秒总 deadline、1024 tokens、32768 bytes、256 events；
  exact allowlist 只有无副作用的 `synthetic.lookup`。
- 0065 保存最小会话/message/event/usage/tool-attempt 状态；租户、门店、staff 与 auth session 由服务端
  注入，FORCE RLS、closed functions、app 无直接 DML，审计只保存 metadata/hash/计数。
- Staff/admin Web 面板支持生成和停止，认证 session 变化时清空状态，输出只按纯文本渲染；关闭状态
  明确显示 AI 未配置/不可用。

## 新鲜 focused 证据

完成 commit 前执行：

```bash
pnpm --filter @laundry/contracts build
pnpm --filter @laundry/contracts exec vitest run \
  test/ai-streaming-contract.test.ts test/openapi-snapshot.test.ts
pnpm --filter @laundry/db build
pnpm --filter @laundry/db exec vitest run \
  test/ai-streaming-migration.test.ts test/migration-files.test.ts
pnpm --filter @laundry/server build
node --test --test-concurrency=1 \
  apps/server/dist/ai/streaming-rate-limit.test.js \
  apps/server/dist/ai/streaming-service.test.js \
  apps/server/dist/http/ai-streaming-routes.test.js
pnpm --filter @laundry/web build
node --test \
  apps/web/dist/host/ai-port.test.js \
  apps/web/dist/shell/ai-panel.test.js
pnpm exec eslint <Item-14 changed TS/TSX files> --max-warnings=0
```

新鲜结果：focused Contracts、DB、Server 与 Web 测试通过；四个 package build/typecheck、focused
ESLint、Prettier、OpenAPI snapshot、文件规模、secret scan 与 `git diff --check` 通过。隔离 PostgreSQL
16 容器从当前分支现有迁移顺序应用到 0065，输出
`AI_0065_REAL_PG_OK`，随后容器已清理；该语法/RLS smoke 不替代集成分支完整 0054–0063 连续迁移门禁。

## 回归覆盖

- Fake SSE end-to-end、持久 terminal replay 和严格 headers。
- 断连/显式 abort、tool step limit、per-tool timeout、输出 event/byte/token 上界和 write backpressure。
- Turn idempotency conflict/replay、single-active turn、组织/auth-session 限流。
- 跨 staff/auth session 隔离、0065 FORCE RLS/ACL、message append-only 和 metadata-only audit。
- Web stream parser、Abort、scope reset、纯文本渲染和明确的 hard-off 错误。

## 明确未验收/失败关闭边界

- 不包含 OpenAI、Anthropic、Gemini 或其他真实 provider adapter、SDK、网络请求、模型选择或 key 读取。
- 不包含 Item 15 业务工具；没有查询真实顾客/订单，也没有写命令或任意 URL/header/tool escape hatch。
- 本结果是 software-only deterministic fake，不声明生产 AI、外部 provider 或成本/隐私 sandbox 已验收。
- 0065 发布时必须接在集成分支完整 0054–0064 后重新运行 real-PG、backup/restore 与部署门禁。
