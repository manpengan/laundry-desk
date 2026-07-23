# ADR 索引

> 维护：Grok（ADR-12 起）　建立：2026-07-20
> **为何独立成文**：总 RFC 的子 ADR 表是 Accepted 正文，按签署记录第 3 条不回改；新增 ADR（09 起）需要一个可持续维护的入口，故本索引附加而非改表。

## v2 产品化线

| ADR                                                                | 主题                                            | 状态                                               |
| ------------------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------- |
| [总 RFC](2026-07-19-v2-productization-and-ai.md)                   | v2 产品化架构 + AI 能力层（总纲，下辖 01–08）   | **Accepted** 2026-07-19；v1 收口条款由 ADR-13 覆盖 |
| [ADR-01](2026-07-19-adr-01-web-first-edge-agent.md)                | Web-first + Local Edge Agent                    | **Accepted**                                       |
| [ADR-02](2026-07-19-adr-02-postgres-multitenancy-rls.md)           | PostgreSQL 多租户与 RLS（M1 强制）              | **Accepted**                                       |
| [ADR-03](2026-07-19-adr-03-garment-order-accounting-model.md)      | 件级衣物 / 订单行 / 账务状态模型                | **Accepted**                                       |
| [ADR-04](2026-07-19-adr-04-offline-consistency.md)                 | 离线一致性（Primary lease 契约）                | **Accepted**                                       |
| [ADR-05](2026-07-19-adr-05-ai-command-policy-approval.md)          | AI 命令总线 / 风险策略 / 确认与审批             | **Accepted**                                       |
| [ADR-06](2026-07-19-adr-06-byok-provider-network-key-mgmt.md)      | BYOK / Provider 网络 / 密钥管理                 | **Accepted**                                       |
| [ADR-07](2026-07-19-adr-07-v1-migration-and-milestones.md)         | v1→v2 迁移与里程碑（方案 B）                    | **Accepted；v1 并行条款由 ADR-13 覆盖**            |
| [ADR-08](2026-07-19-adr-08-release-desktop-upgrade-lts-support.md) | 发布、桌面升级、LTS 与技术支持                  | **Accepted**                                       |
| [ADR-09](2026-07-20-adr-09-command-metadata-precision.md)          | 命令元数据字段精确化（离线档位 / 风险升级阈值） | **Accepted** 2026-07-22                            |
| [ADR-10](2026-07-21-adr-10-single-owner-delivery-governance.md)    | 单一技术负责人 + 受约束协助线（Codex lead）     | **Superseded by ADR-12**                           |
| [ADR-11](2026-07-21-adr-11-auth-lifecycle-envelope.md)             | 身份生命周期信封与认证来源                      | **Accepted**                                       |
| [ADR-12](2026-07-21-adr-12-grok-unified-delivery-ownership.md)     | Grok 统一交付所有权（设计 + 实现）              | **Accepted** 2026-07-21                            |
| [ADR-13](2026-07-23-adr-13-v2-only-upgrade-delivery.md)            | 停止 v1 功能线，统一交付 v2 升级版本            | **Accepted** 2026-07-23                            |

## v1 线

| ADR                                                | 主题            | 状态                                              |
| -------------------------------------------------- | --------------- | ------------------------------------------------- |
| [液态玻璃 UI 2.0](2026-07-18-liquid-glass-ui-2.md) | v1 设计系统升级 | 里程碑由 ADR-13 终止；资产可供 `packages/ui` 复用 |

## 规矩

1. 设计变更**一律新增 ADR**，不回改已 Accepted 的正文（含总 RFC 与架构 spec 定稿部分）。
2. 新 ADR 编号顺延，文件名 `YYYY-MM-DD-adr-NN-<topic>.md`；建后**在本表登记**。
3. 状态流转：`Proposed` → manpengan 签署 → `Accepted`；被后续 ADR 取代的标 `Superseded by ADR-NN`。治理类 ADR 在 manpengan 会话书面授权后可由负责人落档为 Accepted 并合入 main。
4. ADR 正文格式沿用既有：`决策 / 理由 / 否决的备选 / 后果`。
