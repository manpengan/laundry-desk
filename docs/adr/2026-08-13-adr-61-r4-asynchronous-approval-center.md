# ADR-61：R4 异步审批中心与同一命令总线续跑

- 状态：**Proposed**
- 日期：2026-08-13
- 范围：Stage 4.5 Item 16
- 依赖：[ADR-05](2026-07-19-adr-05-ai-command-policy-approval.md)、[ADR-16](2026-07-31-adr-16-edge-operations-scope-ratification.md)、[ADR-37](2026-08-10-adr-37-cloud-web-primary-delivery.md)

## 背景

现有命令总线已经交付 R3 单次确认卡和 R4/R5 现场另一管理员 PIN step-up。Stage 4.5 还要求
R4 发起人无需与复核人在同一设备、同一时刻在线：发起人可把既有确认卡转成异步待办，另一位
管理员在 Owner Web 查看完整参数后批准并执行或填写原因驳回。

异步流程不能成为第二套业务写入口，也不能把 R5 密钥、权限、备份等操作带入 AI。

## 决策

### 1. 单级 R4 授权对象

迁移 `0068_ai_approval_center.sql` 新增 store-scoped `ai_approval_requests`。创建请求时数据库只接受
仍为 pending 的既有 `ai_pending_actions`，且必须满足 `effective_risk=R4`、`policy_outcome=step_up`
和 `requires_other_approver=true`。请求逐字段复制并冻结：

- command/version 与完整 canonical args；
- args hash 与实体版本快照；
- 原始 idempotency key、发起人及其 permission version；
- confirm ref、数据库时钟创建时间和不晚于原确认卡的过期时间。

同一确认卡最多一个异步请求。生命周期固定为
`pending → approved → consumed`、`pending → denied` 或有效期投影为 `expired`；不做多级流程、转签、
加签或扩大有效期。

### 2. 另一管理员权威与单次消费

批准/驳回只允许当前会话的 active admin 且具备 `approval_manage`。数据库在决策事务内重新验证
staff、store role 和 permission version，并拒绝 `requested_by = decided_by`。客户端必须提交
`expected_version`，并发决定只有一个 CAS 胜者；驳回原因必填且最多 500 字。

批准不是客户端获得可复用 token。专用批准路由以原发起人身份、原 confirm ref 和服务器冻结参数
调用现有 `executeCommand`。命令事务内再次验证：发起人仍 active 且 permission version 未变、批准人
仍是另一 active admin 且 permission version 未变、请求/确认卡的 hash、实体版本、幂等键和过期时间
完全一致。随后先 CAS 消费 approval，再 CAS 消费 pending，执行业务 handler，并由既有总线把业务
变化、幂等结果和包含发起人/批准人的审计写在同一事务；失败全部回滚。同步 step-up 路径保持不变。

### 3. HTTP 与 Web 边界

专用 HTTP 面固定为 submit/list/detail/approve/deny 五项；所有输入用严格 Zod，租户只来自服务端
会话。写操作要求 double-submit CSRF、Origin/Fetch Metadata 和独立会话限流；列表最多 100，当前
Web 请求 50。Owner Web 提供待办/历史、完整冻结参数详情、批准并执行和必填原因驳回；列表、详情和
动作均用 AbortSignal 与 generation 丢弃旧响应。

该面只接受 R4。R3 继续单次确认；R4 可选择既有同步 step-up 或本异步中心；R5 永不进入异步审批或
AI 执行。数据库表 FORCE RLS，应用角色只有 SELECT，所有状态写经 SECURITY DEFINER 函数完成。

## 否决的备选

- 审批表保存一份可编辑 payload：会让“审的”与“执行的”分裂。
- 批准后由路由直接写业务表：绕过命令总线 RBAC、不变量、幂等和同事务审计。
- 批准人代替发起人成为业务 actor：会掩盖请求来源，并可能用批准人的更高权限替发起人越权。
- 异步延长确认卡有效期：把五分钟授权静默变成长效能力。
- 把 R5 纳入审批中心：扩大 AI 对密钥、权限和恢复面的投影，违反 ADR-05。

## 后果

- Item 16 交付单店、单级、R4 异步审批，不包含多级 BPM、跨店审批、微信模板通知或桌面端同步 UI。
- 批准已经落库但命令因业务版本变化失败时保留 `approved`，同一批准人可在当前版本下重试；命令
  仍会按冻结实体版本失败关闭，不会重新解释参数。
- `0068` 在独立分支显式预留；统一集成必须先串入 `0065–0067` 再运行连续迁移与真实 PostgreSQL 门禁。
