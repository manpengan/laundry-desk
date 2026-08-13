# ADR-63：有界自动化策略与调度

- 状态：Accepted
- 日期：2026-08-13
- 决策人：Codex（ADR-37 当前交付负责人）
- 适用范围：Stage 4.5 Item 17

## 背景

经营提醒需要按固定时间自动运行，但统一命令总线同时包含退款、免单、余额、权限、密钥、备份恢复等高风险能力。把自由 cron、任意工具名、SQL、URL 或脚本交给浏览器、AI 或 worker，会绕开现有 RBAC、租户、确认、审计和 R4/R5 边界。自动化必须是现有受控命令面的更窄调用者，而不是新的权限面。

## 决策

1. 首个且唯一可自动执行的工具固定为 `notification.delivery_batch.enqueue@0.1.0`。策略只接受服务端 Zod 冻结的对象过滤、每日时刻、非跨午夜时间窗、有效期、每日次数和整数分金额上限；每次最多 10 个对象。不接受 cron、代码、SQL、URL、provider 参数或任意命令参数。
2. 自动化目标必须存在于统一 registry、风险不高于 R3，并继续经过原有 command bus 的租户事务、RBAC、领域 invariant、policy chain、幂等、pending risk 和业务审计。执行 actor 固定为 `via=automation`，staff authority 来自该策略当前仍有效的 admin 批准人。
3. 新建和修改后状态均为 `pending_approval`；只有当前门店 active admin 经 R3 确认卡批准才能进入 `active`。修改会清空旧批准；暂停、恢复和归档使用乐观版本，活动租约期间失败关闭。连续三次失败或额度超限会自动暂停。
4. PostgreSQL 0069 建立 `automation_policies`、不可直写的 `automation_policy_usage_daily` 与追加式 `ai_action_log`。执行前在同一事务依次锁策略和当天额度，保守预占次数与金额；随后业务写入和运行结算仍在该事务完成。额度无法证明、权限变化、租约冲突、过期或窗口不符一律拒绝。
5. 调度器只轮询当前配置门店的权威 `next_run_at`，使用 5 分钟租约和有界批量；时钟、SQL runner、ID 生成、command bus 与 provider capability 都显式注入。无候选记录为 `skipped`，错误以有限安全错误码记录，不保存消息正文、手机号、provider payload 或原始参数，只保存 SHA-256、计数和整数分。
6. Owner Web 提供最小策略 CRUD、批准、暂停/恢复、归档和运行记录。请求采用现有同源认证、CSRF 与 automation 专用限流维度；异步列表和变更使用 generation/`AbortSignal`，卸载或新请求会取消旧响应，避免陈旧状态覆盖。

## 硬禁止边界

- R4/R5 命令，以及退款、免单、余额、权限、凭据/密钥、备份恢复和审计删除，永远不能成为自动化目标。
- 不能从策略或 UI 注入任意命令名、版本、参数、网络地址、模板正文或可执行内容。
- 自动化不能跳过另一管理员复核、pending action、租户上下文、RLS、既有额度、审计或 provider 能力边界。
- 当前 software-only 通知 adapter 只证明软件行为，不代表短信/微信真实送达或产生外部费用。

## 后果

- 自动化能力随 allowlist 扩展而显式扩展。新增任何工具都必须另附 ADR、契约、风险证明、额度规则、数据库约束和验收，不能只改 UI 或配置数据。
- 0069 在最终集成链位于 0065–0068 之后；本 ADR 的独立分支验证不等于连续迁移、required CI、hk-vps 发布或真实 provider 验收。
- 当前 worker 绑定已配置的单门店运行时；跨门店调度需要独立的安全租户发现和公平调度设计。

## 验收

见 [Stage 4.5 Item 17 验收记录](../operations/2026-08-13-stage45-item17-bounded-automation-acceptance.md)。
