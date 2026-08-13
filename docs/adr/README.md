# ADR 索引

> 维护：当前交付 owner（见最新 Accepted 治理 ADR）　建立：2026-07-20
> **为何独立成文**：总 RFC 的子 ADR 表是 Accepted 正文，按签署记录第 3 条不回改；新增 ADR（09 起）需要一个可持续维护的入口，故本索引附加而非改表。

## v2 产品化线

| ADR                                                                           | 主题                                            | 状态                                               |
| ----------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| [总 RFC](2026-07-19-v2-productization-and-ai.md)                              | v2 产品化架构 + AI 能力层（总纲，下辖 01–08）   | **Accepted** 2026-07-19；v1 收口条款由 ADR-13 覆盖 |
| [ADR-01](2026-07-19-adr-01-web-first-edge-agent.md)                           | Web-first + Local Edge Agent                    | **Accepted**                                       |
| [ADR-02](2026-07-19-adr-02-postgres-multitenancy-rls.md)                      | PostgreSQL 多租户与 RLS（M1 强制）              | **Accepted**                                       |
| [ADR-03](2026-07-19-adr-03-garment-order-accounting-model.md)                 | 件级衣物 / 订单行 / 账务状态模型                | **Accepted**                                       |
| [ADR-04](2026-07-19-adr-04-offline-consistency.md)                            | 离线一致性（Primary lease 契约）                | **Accepted**                                       |
| [ADR-05](2026-07-19-adr-05-ai-command-policy-approval.md)                     | AI 命令总线 / 风险策略 / 确认与审批             | **Accepted**                                       |
| [ADR-06](2026-07-19-adr-06-byok-provider-network-key-mgmt.md)                 | BYOK / Provider 网络 / 密钥管理                 | **Accepted**                                       |
| [ADR-07](2026-07-19-adr-07-v1-migration-and-milestones.md)                    | v1→v2 迁移与里程碑（方案 B）                    | **Accepted；v1 并行条款由 ADR-13 覆盖**            |
| [ADR-08](2026-07-19-adr-08-release-desktop-upgrade-lts-support.md)            | 发布、桌面升级、LTS 与技术支持                  | **Accepted**                                       |
| [ADR-09](2026-07-20-adr-09-command-metadata-precision.md)                     | 命令元数据字段精确化（离线档位 / 风险升级阈值） | **Accepted** 2026-07-22                            |
| [ADR-10](2026-07-21-adr-10-single-owner-delivery-governance.md)               | 单一技术负责人 + 受约束协助线（Codex lead）     | **Superseded by ADR-12**                           |
| [ADR-11](2026-07-21-adr-11-auth-lifecycle-envelope.md)                        | 身份生命周期信封与认证来源                      | **Accepted**                                       |
| [ADR-12](2026-07-21-adr-12-grok-unified-delivery-ownership.md)                | Grok 统一交付所有权（设计 + 实现）              | **Superseded by ADR-14**                           |
| [ADR-13](2026-07-23-adr-13-v2-only-upgrade-delivery.md)                       | 停止 v1 功能线，统一交付 v2 升级版本            | **Accepted**；宏发目标与迁移顺序由 ADR-14 覆盖     |
| [ADR-14](2026-07-25-adr-14-generic-local-first-v2-delivery.md)                | 通用 V2 本地优先交付与 Codex 接管               | **Accepted** 2026-07-25；§4 阶段线由 ADR-16 修订   |
| [ADR-15](2026-07-28-adr-15-catalog-maintenance-unfreeze.md)                   | 解冻价目写入，补齐首期价目维护                  | **Accepted** 2026-07-28                            |
| [ADR-16](2026-07-31-adr-16-edge-operations-scope-ratification.md)             | 边缘运营范围追认与契约面 ADR 门禁               | **Accepted** 2026-07-31                            |
| [ADR-17](2026-07-31-adr-17-member-stored-value.md)                            | 会员储值：组织级账户与只追加账本                | **Accepted** 2026-07-31；解冻 ADR-16 的会员后置项  |
| [ADR-18](2026-08-01-adr-18-stored-value-settlement-reporting.md)              | 储值核销单列对账、不进钱箱                      | **Accepted** 2026-08-01                            |
| [ADR-19](2026-08-01-adr-19-ordinary-offline-grant-replay.md)                  | 普通 offline grant 独立序号与权威重放           | **Accepted** 2026-08-01                            |
| [ADR-20](2026-08-01-adr-20-authoritative-edge-print-dispatch.md)              | 权威打印快照、一次性派发与设备回执              | **Accepted** 2026-08-01                            |
| [ADR-21](2026-08-01-adr-21-independent-macos-runtime-app.md)                  | 独立 Runtime.app 管理本地 Server/PostgreSQL     | **Accepted** 2026-08-01                            |
| [ADR-22](2026-08-01-adr-22-member-stored-value-phase-2.md)                    | 储值现金口径、充值赠送与本金退款                | **Accepted** 2026-08-01                            |
| [ADR-23](2026-08-07-adr-23-pickup-reminder-manual-list.md)                    | 催取工作台与人工通知名单                        | **Accepted** 2026-08-07；仅解冻人工降级切片        |
| [ADR-24](2026-08-07-adr-24-accounting-dual-basis-reports.md)                  | 账目双口径与日/月/职员报表                      | **Accepted** 2026-08-07；仅交付 Linux 本地 Web     |
| [ADR-25](2026-08-07-adr-25-member-account-lifecycle.md)                       | 会员账户冻结、解冻与原子关户                    | **Accepted** 2026-08-07；仅交付 Linux 本地 Web     |
| [ADR-26](2026-08-07-adr-26-lan-owner-dashboard.md)                            | 局域网只读 Owner Dashboard 与 HTTPS 边界        | **Accepted** 2026-08-07；单店 LAN Web              |
| [ADR-27](2026-08-08-adr-27-owner-drilldown-portfolio.md)                      | Owner 明细下钻与授权门店组合视图                | **Accepted** 2026-08-08；LAN 只读扩展              |
| [ADR-28](2026-08-08-adr-28-lan-onboarding-diagnostics.md)                     | LAN 设备接入与证书诊断                          | **Accepted** 2026-08-08；不扩大代理面              |
| [ADR-29](2026-08-08-adr-29-runtime-managed-backup-restore.md)                 | Runtime.app 管理的本地备份与恢复                | **Accepted** 2026-08-08；仅原生主机维护入口        |
| [ADR-30](2026-08-08-adr-30-runtime-release-upgrade-rollback.md)               | Runtime.app 发布、升级与受控回滚                | **Accepted** 2026-08-08；正式凭据仍为外部门禁      |
| [ADR-31](2026-08-08-adr-31-store-commissioning-staff-credentials.md)          | 新店投产、第二审批人与员工凭据生命周期          | **Accepted** 2026-08-08；Runtime 一次性投产        |
| [ADR-32](2026-08-08-adr-32-runtime-managed-lan-operations.md)                 | Runtime 托管 LAN 生命周期、诊断与支持包         | **Accepted** 2026-08-08；LAN 仍为固定只读面        |
| [ADR-33](2026-08-08-adr-33-runtime-portable-data-protection.md)               | Runtime 定时备份、加密导出与换机恢复            | **Accepted** 2026-08-08；不复制实例或设备权威      |
| [ADR-34](2026-08-08-adr-34-device-local-cups-printer-configuration.md)        | 设备本地 CUPS 配置与 XP-58 实体验收边界         | **Accepted** 2026-08-08；实体出纸仍为外部门禁      |
| [ADR-35](2026-08-08-adr-35-portable-release-candidate-evidence.md)            | 可携带正式候选证据与离线验证权威                | **Accepted** 2026-08-08；正式外部证据失败关闭      |
| [ADR-36](2026-08-09-adr-36-cloud-test-environment.md)                         | hk-vps 云测试环境与完整柜台面公网暴露           | **Accepted** 2026-08-09；仅限合成数据的开发测试    |
| [ADR-37](2026-08-10-adr-37-cloud-web-primary-delivery.md)                     | Cloud Web-first 主交付线与剩余功能 1–4 顺序     | **Accepted** 2026-08-10；桌面/硬件正式交付后置     |
| [ADR-38](2026-08-11-adr-38-cloud-counter-trust-closure.md)                    | 柜台可信计价、支付退款与挂单明细闭环            | **Accepted** 2026-08-11；Cloud Web 阶段 2          |
| [ADR-39](2026-08-11-adr-39-catalog-governance.md)                             | 价目启停恢复、原子排序与安全审计                | **Accepted** 2026-08-11；Cloud Web 阶段 3.1        |
| [ADR-40](2026-08-11-adr-40-cloud-owner-operations.md)                         | Owner 公网经营、完整报表与授权门店管理          | **Accepted** 2026-08-11；Cloud Web 阶段 3.2        |
| [ADR-41](2026-08-11-adr-41-member-benefits-and-expiry.md)                     | 会员等级、积分、次卡、优惠券与权益有效期        | **Accepted** 2026-08-11；Cloud Web 阶段 3.3        |
| [ADR-42](2026-08-12-adr-42-customer-extended-profiles-and-discount-policy.md) | 顾客扩展档案、运营豁免与折扣政策                | **Accepted** 2026-08-12；Cloud Web 阶段 3.4        |
| [ADR-43](2026-08-12-adr-43-cloud-data-protection-and-joint-recovery.md)       | Cloud 数据保护、离机副本与联合恢复              | **Accepted** 2026-08-12；Cloud Web 阶段 4.1        |
| [ADR-44](2026-08-12-adr-44-provider-neutral-notification-outbox.md)           | Provider-neutral 通知 outbox、回执与人工降级    | **Accepted** 2026-08-12；Cloud Web 阶段 4.2        |
| [ADR-45](2026-08-12-adr-45-factory-handoff-and-qc.md)                         | 店厂四节点交接、清点差异与质检返工              | **Proposed** 2026-08-12；实现候选待 manpengan 签署 |
| [ADR-46](2026-08-13-adr-46-delivery-policy-and-policy-only-availability.md)   | 门店取送策略与不占位可预约报价                  | **Proposed** 2026-08-13；实现候选待 manpengan 签署 |
| [ADR-47](2026-08-13-adr-47-customer-delivery-appointments.md)                 | 顾客取送预约、改期与取消                        | **Proposed** 2026-08-13；实现候选待 manpengan 签署 |
| [ADR-48](2026-08-13-adr-48-authoritative-delivery-orders.md)                  | 权威配送订单与取送生命周期                      | **Proposed** 2026-08-13；实现候选开发中            |
| [ADR-49](2026-08-13-adr-49-authoritative-delivery-tasks.md)                   | 配送任务分派、接单、转派与人工接管              | **Proposed** 2026-08-13；实现候选开发中            |
| [ADR-50](2026-08-13-adr-50-mobile-delivery-task-h5.md)                        | 配送员/员工移动 H5 我的任务工作台               | **Proposed** 2026-08-13；实现候选本地门禁已通过    |

## v1 线

| ADR                                                | 主题            | 状态                                              |
| -------------------------------------------------- | --------------- | ------------------------------------------------- |
| [液态玻璃 UI 2.0](2026-07-18-liquid-glass-ui-2.md) | v1 设计系统升级 | 里程碑由 ADR-13 终止；资产可供 `packages/ui` 复用 |

## 规矩

1. 设计变更**一律新增 ADR**，不回改已 Accepted 的正文（含总 RFC 与架构 spec 定稿部分）。
2. 新 ADR 编号顺延，文件名 `YYYY-MM-DD-adr-NN-<topic>.md`；建后**在本表登记**。
3. 状态流转：`Proposed` → manpengan 签署 → `Accepted`；被后续 ADR 取代的标 `Superseded by ADR-NN`。治理类 ADR 在 manpengan 会话书面授权后可由负责人落档为 Accepted 并合入 main。
4. ADR 正文格式沿用既有：`决策 / 理由 / 否决的备选 / 后果`。
