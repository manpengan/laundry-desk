# A5 会话、refresh、CSRF 与 PIN 契约验收单

- 日期：2026-07-21
- 状态：**contract-only 冻结候选，待 PR/main CI**
- 设计真源：[`2026-07-21-a5-session-csrf-design.md`](../../../specs/2026-07-21-a5-session-csrf-design.md)
- 架构裁决：[`ADR-11`](../../../../adr/2026-07-21-adr-11-auth-lifecycle-envelope.md)
- 实现计划：[`2026-07-21-a5-session-csrf-implementation-plan.md`](../../2026-07-21-a5-session-csrf-implementation-plan.md)

## 1. 结论边界

A5 已把 browser session 来源、refresh 状态判定、CSRF、PIN quick-switch/step-up、身份 lifecycle
入口和固定公共错误冻结成严格 schema、纯 decision、运行时 provenance guard 及不可变矩阵。本结论
只覆盖 `packages/contracts`；没有实现或证明 C6/C8 的数据库、密码学、HTTP/cookie、并发、限速、
审计和 E2E。

因此本单只标记为**冻结候选**。分支 PR 的 Build/Release 与 V2 Foundation 尚未在本单执行，合入后
main merge commit 也尚未验证；两者全绿前不得写“已冻结”或解锁生产 runtime 验收。

## 2. ADR-11 与入口权限

ADR-11 不为 pre-auth login 或 access 已过期的 refresh/logout 伪造 actor/tenant。三项 lifecycle
操作使用无 actor/tenant/dry-run/confirm-ref 的 `IdentityLifecycleEnvelope`，同时仍必须进入注册表、
限速、事务、安全事件审计和事件投递边界。普通 A2 command 只接受有来源的 browser session 或
Edge replay 联合。

根入口只公开浏览器 schema、纯判定、guard 和类型。下列可信发行能力必须保持在 package exports
已限制的服务器子路径，且 foundation lint 约束调用目录：

- `@laundry/contracts/browser-auth-ingress`：`issueBrowserSessionSource()`、
  `issueIdentityLifecycleEnvelope()`；
- `@laundry/contracts/edge-auth-ingress`：`issueEdgeReplaySource()`。

`registerIdentityLifecycleEnvelope()` 是包内 registrar，根入口与 package subpath 都不公开。根入口也
不公开 server-only `ServerSessionRecordSchema`、`RefreshTokenRecordSchema`、
`RefreshFamilyRecordSchema`、`PinChallengeSchema`、`PinVerificationSchema` 或
`StepUpProofSchema`。

## 3. RED → GREEN 证据

Task 6 先新增根入口消费者和类型测试，再接线导出。

| 阶段 | 命令 | 结果 |
| ---- | ---- | ---- |
| RED | `pnpm --filter @laundry/contracts test -- consumers auth-` | 非零；580 项中 5 项按预期因 public auth 导出为 `undefined` 失败 |
| RED | `pnpm --filter @laundry/contracts typecheck` | 非零；`TS2305` 明确列出缺失的 browser schema、decision、guard/type 根导出 |
| GREEN | `pnpm --filter @laundry/contracts test -- consumers auth-` | 30 files / 580 tests 全绿；statements 95.32%、branches 90.87%、functions 98.17%、lines 95.32% |
| GREEN | `pnpm --filter @laundry/contracts typecheck` | 生产与测试 tsconfig 均为零退出 |

完整回归在提交前重新运行，以最终一轮输出为准；定向 GREEN 不是 PR/main CI 证据。

## 4. A7 唯一投影源与精确负向断言

`AUTH_OPERATION_MATRIX` 是 A7 auth OpenAPI 的**唯一**投影源。A7 必须逐行消费矩阵中的 literal
method/path/schema id 与 `request_schema`/`response_schema` 引用，不能扫描根入口或按名字推断。
精确投影只有以下五行：login、refresh、logout、PIN challenge、PIN verify。

Task 6 消费者测试固定以下负向事实：

1. 矩阵 request schema 引用精确等于 login、empty、empty、PIN challenge、PIN verify；response
   引用精确等于 access session、access session、logout、PIN challenge、PIN verify；
2. 根入口不存在三个 `issue*` authority、内部 registrar、session/refresh server record 与 PIN
   server-only schema；同形、spread、JSON 往返对象不能通过 provenance guard；foundation lint
   会以 TypeScript AST 识别 package 与 relative `src`/`dist` import，规范化 query/fragment 与 Windows
   分隔符，覆盖 dynamic import、`require()`、TS `import = require()`；生产源码的非字面量 loader
   fail-closed，test exception 仅限不进入生产 tsconfig 的 contracts `*.test.*`，且不能被生产源转引；
3. `LoginRequestSchema`、`PinVerifyRequestSchema`、`PinSchema` 与 `CsrfProofSchema` 的 metadata
   没有 examples；
4. 全部响应 schema 都拒绝额外的 `password`、`pin`、`refresh_token`、`csrf_token`、`token_hash`、
   `challenge_binding`；矩阵 JSON 不包含测试 secret；
5. auth 固定错误只有固定 message/status，不接受 detail；unknown/revoked/reused refresh 不能由公共
   输出区分。

A7 不得投影 refresh token/family record、hash、server challenge/proof、authority、provenance brand
或 cookie 中的 secret value。access token 是合法响应字段，但其 `storage: "memory_only"` 是强制
消费约束，不是持久化建议。

## 5. C6/C8 runtime 缺口

| 消费方 | 尚未由 A5 证明的 runtime 责任 |
| ------ | ------------------------------ |
| C6 identity | Argon2id/JWT/MAC 与 key rotation；session/family/token/challenge/proof repository；行锁/CAS/事务 single-winner；refresh reuse 级联撤销；PIN 失败计数、锁定、单次消费；Set-Cookie/clear；限速、安全事件审计、事件投递 |
| C8 auth ingress | Origin/Fetch Metadata allowlist；CSRF proof 签发、session/family 绑定和恒定时间比较；每请求 JWT 验签及 active/version/actor/tenant/device 回读；只在验证后调用受限 authority；向 Command Bus 注入可信来源 |
| 集成验收 | 真实 PostgreSQL 并发、HTTP cookie 属性、跨源拒绝、旧 access 撤销、固定攻击、异常/回滚、桌面/Web 登录与 PIN E2E |

纯 decision 的 compare/effects plan、CAS classifier、mock 或单进程单测都不能替代以上证据。C6/C8
必须把成功事务、失败回滚与审计完整性放在同一 runtime 验收链中。

## 6. 提交前全量门禁

最终提交必须保存以下零退出证据：

```bash
pnpm --filter @laundry/contracts test
pnpm --filter @laundry/contracts typecheck
pnpm --filter @laundry/contracts lint
pnpm run workspace:check
git diff --check
git diff --check origin/main...HEAD
git diff --exit-code origin/main -- package-lock.json pnpm-lock.yaml
```

双锁文件检查必须无输出；A5 没有新增依赖。另需完成 whole-range spec、TypeScript quality 与 security
三条独立复审，所有 blocker/major 清零。PR/main CI 仍按 Task 6 Step 8 保持未完成。

最终 fresh 结果：contracts 30 files / 581 tests 全绿，statements 95.32%、branches 90.88%、
functions 98.17%、lines 95.32%；foundation authority 门禁 9/9；contracts typecheck/lint、完整
`workspace:check` 均零退出；worktree/range diff-check 与双锁文件检查均零退出、无输出。whole-range
spec、TypeScript quality、security 三条独立复审最终均为 CLEAN（0 blocker / 0 major / 0 minor）。
