# Stage 4.5 Item 15 — read-only AI assistant acceptance

日期：2026-08-13
基线：`382bee420ca3f44b9d633ae0c3664ab8076e9ef0`
分支：`codex/stage45-item15-readonly-assistant`

## 验收范围

- Contracts 冻结 `business.summary`、`records.search`、`procedure.troubleshoot` 三个工具，
  参数严格 Zod，结果必须有来源、安全筛选和有界条目。
- Server 业务读取只复用既有 Query Bus；当前 session 注入 tenant/permissions，
  query 继续执行 RBAC、read-only transaction、GUC 与参数化 handler。
- 订单/顾客投影遮蔽姓名和电话，不返回备注/地址/secret；规程只来自随版本
  发布的固定文档。
- Item 15 runtime 最多 3 tool calls、800ms/tool、10 results/tool，且继续受 Item 14
  total deadline/token/byte/event 上限。
- 0067 仅扩展工具闭集和 metadata count，closed function 只写 hash/count/outcome/duration
  审计；应用角色仍无直接 DML。
- 柜台与 Owner 共用纯文本 AI 抽屉及三类快捷问题。

## 本地验证

```bash
pnpm --filter @laundry/contracts exec vitest run \
  test/ai-assistant-contract.test.ts test/ai-streaming-contract.test.ts \
  test/openapi-snapshot.test.ts --coverage=false
pnpm --filter @laundry/db exec vitest run \
  test/readonly-ai-assistant-migration.test.ts test/migration-inventory.test.ts \
  test/destructive-migration.test.ts test/ai-streaming-migration.test.ts \
  test/ai-safety-migration.test.ts test/approval-center-migration.test.ts \
  test/bounded-automation-migration.test.ts --coverage=false
pnpm --filter @laundry/server build
node --test --test-concurrency=1 \
  apps/server/dist/ai/readonly-assistant-tool.test.js \
  apps/server/dist/ai/streaming-service.test.js \
  apps/server/dist/http/ai-streaming-routes.test.js
pnpm --filter @laundry/web build
node --test \
  apps/web/dist/host/ai-port.test.js apps/web/dist/shell/ai-panel.test.js \
  apps/web/dist/owner/owner-surface.test.js
```

Contracts focused 为 3 files / 12 tests 通过；DB focused 为 7 files / 23 tests 通过。
Server focused 为 3 files / 15 tests 通过；Web focused 为 3 files / 13 tests 通过。
Contracts、DB、Server、Web lint 全部通过；各包 typecheck 通过，Contracts、DB、Server、
UI 与 Web production build 通过。

独立 `postgres:16-alpine`（server 16.14）空库已按文件序连续应用 0001→0069，因而
0065→0066→0067→0068→0069 无缺口。以 `laundry_app` 和 transaction-local tenant/auth GUC
经生产 `_safe`/safety authority 创建并启动 turn 后，0067 closed function 成功追加
`business.summary|2|1|1|succeeded`。实测应用角色对 `ai_tool_attempts` 无 INSERT、对 closed
function 有 EXECUTE；错误 auth-session GUC 以 insufficient privilege 失败。对应 audit 只有
`tool_name/step/outcome/duration_ms/result_count/source_count/filter_count`，注入 fixture 的问题文本
与手机号未进入该 audit。

## 明确未验收边界

- 不实现或调用真实 provider adapter/SDK，不读 key，不发起外网请求。
- 不存在写工具、自由 SQL、任意 URL/header 或未知 tool fallback。
- deterministic fake 证据不等于生产 AI 、真实模型或 provider sandbox 验收。
