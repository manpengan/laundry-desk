# contracts@v0.1.0 封版记录

- 日期：2026-07-22
- 维护：Grok（ADR-12）
- 授权：manpengan 会话书面授权签署 ADR-09 并封版

## 前置闸

| 闸 | 状态 |
| --- | --- |
| A1 命令/查询注册表 | ✅ 已冻结 |
| A2 统一信封 + 错误码 | ✅ 已冻结 |
| A3 租户矩阵 / RLS 模板 | ✅ 已冻结（contract-only） |
| A4 Edge 桥协议 | ✅ 已冻结 |
| A5 会话 / CSRF / PIN | ✅ 已冻结（contract-only） |
| A6 M1 首批 identity/platform 定义 | ✅ 已冻结 |
| A7 OpenAPI 3.1 快照 | ✅ 已冻结 |
| ADR-09 命令元数据精确化 | ✅ **Accepted** 2026-07-22 |

## 版本

- npm 包：`@laundry/contracts@0.1.0`（`packages/contracts/package.json`）
- git tag（合入 main 后打）：`contracts@v0.1.0`

## 封版含义

1. **不是运行时放行闸**：逐组冻结时下游已可依赖；本 tag 标记「七组 + ADR-09」齐备的协议快照。
2. **此后改契约**：不回改已 Accepted ADR；形状变更走**新增 ADR**，并按 ADR-08 评估 contracts major / 兼容窗口。
3. **本包不实现**：C1 总线执行、C2 生产 PG 接线、C6 密码学与会话 IO、C8 HTTP 中间件等仍属 runtime；契约只冻结类型、纯判定与投影。

## 证据

- `pnpm --filter @laundry/contracts test` 绿（封版 PR CI）
- OpenAPI 快照：`packages/contracts/openapi/laundry-v2.openapi.json`
- ADR-09 签署块：`docs/adr/2026-07-20-adr-09-command-metadata-precision.md`
