# 活动 V2 文件规模质量门禁设计

> 日期：2026-07-27
>
> 状态：**Approved**
>
> Owner：Codex
>
> 路线：[ADR-14](../../adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md)

## 1. 问题

上级工程规则将单文件 200–400 行定义为推荐范围、800 行定义为硬上限，但仓库
`AGENTS.md` 尚未记录这条政策。Local Foundation 在保持测试与安全边界的同时
产生了 12 个新跨过 400 行的生产文件，当前 ESLint 也没有自动执行文件规模
门禁，因此新文件和既有大文件都可能继续增长。

当前活动 V2 生产代码没有超过 800 行；最高为
`apps/edge-agent/src/desktop/http-transport.ts` 的 799 行。另有
`tests/foundation/local-foundation.test.mjs` 达到 854 行，已经超过硬上限。

本设计只收紧质量门禁和拆分超限测试，不重构业务行为，不改变 Local Foundation
运行时、协议或打包边界。

## 2. 决策

### 2.1 两级门禁

- 在仓库 `AGENTS.md` 增加活动 V2 生产文件 400 行、测试文件 800 行的可追溯
  政策；
- 活动生产 JavaScript/TypeScript 文件默认最多 400 个物理行；
- 测试文件最多 800 个物理行；
- `max-lines` 统计注释和空行，避免通过格式调整绕过文件聚焦要求；
- 生成目录、依赖目录、冻结的根 `src/` v1 与构建产物不进入本轮门禁。

真实文件规模门禁由默认 `workspace:lint` 执行；`workspace:test` 只运行虚拟文件
配置回归，证明 400/800 边界没有被关闭或放宽。两者都不能替代人工判断文件是否
应该继续拆分。

### 2.2 既有生产文件冻结预算

既有超过 400 行的活动生产文件不在本轮进行批量重构。每个文件获得等于当前物理
行数的显式 ESLint 上限；任何继续增长都会失败，触碰该文件的后续功能必须先提取
聚焦模块或减少现有体积。

| 冻结上限 | 文件                                            |
| -------: | ----------------------------------------------- |
|      799 | `apps/edge-agent/src/desktop/http-transport.ts` |
|      795 | `apps/server/src/local/bootstrap.ts`            |
|      773 | `apps/server/src/identity/pg-store.ts`          |
|      687 | `apps/edge-agent/scripts/sync-spa.mjs`          |
|      671 | `apps/web/src/host/desktop-ports.ts`            |
|      632 | `apps/server/src/http/login-rate-limit.ts`      |
|      549 | `packages/contracts/src/auth/pin.ts`            |
|      534 | `apps/web/src/auth/HttpAuthClient.ts`           |
|      533 | `packages/contracts/src/index.ts`               |
|      506 | `apps/server/src/order/pg-order-store.ts`       |
|      481 | `apps/server/src/identity/memory-store.ts`      |
|      474 | `tools/local/config.mjs`                        |
|      457 | `apps/server/src/local/create-runtime.ts`       |
|      456 | `apps/server/src/identity/pg-pin-repo.ts`       |
|      418 | `apps/server/src/identity/session.ts`           |
|      411 | `apps/web/src/pages/ReceivePage.tsx`            |

其中 `packages/contracts/src/auth/pin.ts`、`packages/contracts/src/index.ts`、
`apps/server/src/order/pg-order-store.ts` 与 `apps/web/src/pages/ReceivePage.tsx`
在 `main` 已超过 400 行，其余 12 个是当前分支新跨过推荐范围的文件。预算是技术
债上限，不是长期豁免。

### 2.3 拆分唯一硬超限测试

把 `local-foundation.test.mjs` 中 HTTP smoke 的 fake process、敏感环境和两项
凭据泄露测试移到
`tests/foundation/local-foundation-http-smoke.test.mjs`。两个文件继续由同一
`tests/foundation/*.test.mjs` 默认门禁执行；只移动测试及其私有 helper，不改变
断言或被测代码。

## 3. 配置边界

- `packages/config/eslint/base.cjs` 对各 workspace 的活动生产代码启用默认 400
  行、测试代码启用 800 行；
- 各 package `.eslintrc.cjs` 只声明本 package 的冻结预算；
- 根 `.eslintrc.cjs` 只能通过 `overrides.files` 对 `tools/local/**` 与
  `tests/foundation/**` 使用同样规则，不得把 `max-lines` 放入根级全局
  `rules`；同时为 `tools/local/config.mjs` 声明冻结预算；
- `workspace:lint` 显式覆盖 `tests/foundation`，避免测试硬上限只写在配置中却
  从未执行。

测试 override 必须完整匹配 `*.test.*`、`*.spec.*`、`test/**`、`tests/**`、
`__tests__/**` 与 `e2e/**`；这些路径使用 800 行上限，不得错误继承生产 400 行
上限。

不增加自定义扫描器或新的 lint 依赖；使用当前 ESLint 内建 `max-lines` 规则。

## 4. 验证

1. 在 `workspace:test` 中用 ESLint API 对虚拟文件验证：
   - 400 行生产文件通过；
   - 401 行生产文件命中 `max-lines`；
   - 800 行测试通过；
   - 801 行测试命中 `max-lines`。
2. 先运行该测试并观察现有配置下的 RED，再增加规则和冻结预算达到 GREEN。
3. 拆分 foundation 测试后运行全部 `tests/foundation/*.test.mjs`。
4. 运行 `workspace:lint`，确认活动真实文件全部满足默认上限或各自冻结预算。
5. 运行 `pnpm workspace:check`，确认格式、lint、strict typecheck、测试与构建全部
   通过。

## 5. 非目标

- 本轮不把 16 个既有大文件全部重构到 400 行以内；
- 不为签名、公证、云部署、Windows 或完整柜台工作日扩大范围；
- 不修改 Gitea 或推送远程分支。
