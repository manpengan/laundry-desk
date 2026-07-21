# A6 评审单：M1 首批命令定义（identity / platform）

> 主责：**Grok**（ADR-12）　落点：`packages/contracts/src/commands/`  
> 前置：A1 注册表、A2 信封、A5 会话/CSRF/PIN 输入 schema、F1 secret≠R5 裁定  
> 状态：**✅ 已冻结（合入 main 后生效）**

## 1. 范围

| 名称 | 种类 | risk | classification | offline |
| --- | --- | --- | --- | --- |
| identity.login | command | R1 | secret | denied |
| identity.refresh | command | R1 | secret | denied |
| identity.logout | command | R0 | internal | denied |
| identity.pin_challenge | command | R2 | internal | denied |
| identity.pin_verify | command | R2 | secret | denied |
| platform.settings.get | query | R1 | internal | denied |
| platform.settings.set | command | **R5** | internal | denied |
| platform.store_features.get | query | R0 | internal | denied |
| platform.audit.list | query | R2 | pii | denied |

## 2. 通过标准

- [x] 全部经 `defineCommand` / `defineQuery` 注册（`isContractDefinition`）
- [x] secret 命令：`offline_mode: denied` + password/pin **remove** 脱敏；**非** R5（F1）
- [x] settings.set 为 R5，不可 AI 投影
- [x] 与 AUTH_OPERATION_MATRIX 命令名对齐（login/refresh/logout）
- [x] vitest 覆盖 catalog

## 3. 非范围

- C6 运行时、HTTP handler、cookie 签发实现  
- 完整 RBAC 权限点枚举（仅 binding 名占位）  
