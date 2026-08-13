# ADR-52：当前门店营销活动、受众摘要与预算上限

- 日期：2026-08-13
- 状态：**Proposed（实现候选已落地，待 manpengan 签署）**
- 决策者：manpengan
- 路线：[ADR-37：Cloud Web 主交付形态](2026-08-10-adr-37-cloud-web-primary-delivery.md)
- 契约门禁：[ADR-16：边缘运营范围与契约面](2026-07-31-adr-16-edge-operations-scope-ratification.md)
- 影响：Contracts、`0059`、Server marketing、Owner Web、Cloud 验收

## 背景

Stage 4.4 Item 7 要让店主先定义营销活动、筛选受众、限制时间窗和预算，但 Item 8 才负责批量发券、
资格复核、核销与冲正。把两项合成一个入口会让“保存活动”暗中产生有价值资产，也会在没有资格、
幂等和冲正协议时形成资金风险。因此本片只建立活动与冻结受众的权威元数据，不发券、不发送消息、
不调用外部 provider。

早期 tenant matrix 把尚未实现的 `campaigns` 预留为 org scope。当前 Cloud Owner 授权只证明一个
会话门店，且没有组织级营销管理员或跨店预算协议。本 ADR 以可证明的当前权限覆盖该占位：活动、
受众摘要和预算流水都严格是 `org_id + store_id` scope。

## 决策

### 1. 严格白名单受众 DSL

唯一可提交的受众规则是三个必填维度，所有对象拒绝额外字段：

```text
customer_age  = any | within_days(1..3650)
order_activity = any | none | within_days(1..3650)
membership    = any | member | non_member | tiers(1..20 unique UUID)
```

服务端 PostgreSQL 实现使用一条固定参数 SQL，不拼接列名、运算符或 SQL 片段。候选只包含同组织的
canonical、未匿名化顾客；订单活跃只看当前门店；会员账户按组织读取，等级有效日以当前门店时区
计算。候选按 customer UUID 稳定排序并截断到 1–500 的 `recipient_limit`。

浏览器和查询响应都不取得顾客 id、姓名、手机号或地址。`preview` 只返回匹配数、截断后人数、规则
摘要和受众摘要。数据库再次用独立 `jsonb` validator 拒绝未知 key、未知 kind、越界数字、重复或
非法 tier id；应用 Zod 不是数据库完整性的替代。

### 2. Campaign set 与状态、版本、时间窗

`marketing.campaign.set` 同时承担创建和乐观更新：创建必须 `expected_version=0` 且不传 id；更新
必须传 id 和正版本。代码创建后不可改，名称、状态、规则、窗口、人数和预算可在版本吻合时更新。
状态固定为 `draft | scheduled | paused | cancelled`；`cancelled` 和已经结束的活动不可再更新。

窗口必须 `ends_at > starts_at`，最长 730 天。时间只接受规范 UTC timestamp；PostgreSQL trigger
覆盖 `created_at/updated_at` 为数据库 clock。预算单位固定为整数分，范围 1–5,000,000；不得使用
浮点金额。数据库拒绝把预算下调到已用预算以下。

该命令是 R3、online-only、admin-only `marketing_manage`，并按预算声明 factory amount measure；
超过 500,000 分升级 R4，且硬上限 5,000,000 分。命令进入统一持久幂等、确认和同事务 audit，不
进入 Edge、automation 或 AI 投影。

首跳 pending authority 由 Server 在同一事务内生成，并完整冻结 id/expected version、代码、名称、
状态、UTC 时间窗、整数预算、人数上限和三维受众规则。R3/R4 确认卡逐项显示这些字段；二跳只接受
`confirm_ref`，handler 再把 hash-bound authority 与原始命令逐字段比较。任一字段漂移均
`POLICY_DENIED`，不得由浏览器用本地文案替代服务端权威。

### 3. 预览与 digest-only 受众冻结

`marketing.campaign.audience.preview` 接受 campaign id 和 expected version，在服务端重新读取规则并
评估。摘要绑定：

```text
campaign id + campaign version + audience_rule_sha256 + sorted bounded customer ids
```

`marketing.campaign.audience.freeze` 是 R3 幂等写，只接受上述 preview digest 与预期人数。执行时先锁
campaign，再重新评估；版本、digest 或人数任一漂移即整笔失败，调用者必须重新预览。成功后只追加：

- snapshot id、campaign version、rule SHA-256；
- audience SHA-256、recipient count、staff 和数据库时间。

不保存 recipient id 列表。这减少新的 PII 副本，也意味着 Item 8 发券时必须重新评估同一规则并精确
匹配 snapshot digest；不匹配时不得发放。snapshot 不能被 UPDATE/DELETE；同 campaign/version/digest
重放复用同一语义记录。

freeze 首跳同样由 Server 重新评估，确认卡冻结 campaign id/code/name/version、规则摘要、受众摘要
和人数，不包含顾客 id。二跳再次评估；版本、摘要或人数变化均拒绝旧确认卡。

### 4. 预算账本是上限 authority，不是发券入口

`campaign_budget_ledger` 预留 append-only 正整数分流水，当前唯一 kind 为 `coupon_issue`，并用
`(campaign, kind, source_id)` 去重。插入 trigger 先 `FOR UPDATE` 锁 campaign，再汇总已用金额，拒绝
超过上限的写入；campaign 更新也检查已用金额。

Item 7 没有任何命令写该表，因此当前 `budget_used_cents=0`，不能据此声称券已发放。Item 8 必须用
新 ADR 同时定义资格、grant/issue 事务、source id、核销和冲正后，才能获得预算账本写权限的业务
路径；Item 7 的 `laundry_app` 对该表只有 SELECT，直接 INSERT 由 ACL 拒绝，不得用 Web 或 SQL
绕过命令总线。

### 5. 租户、权限、feature 与审计

`campaigns`、`campaign_audience_snapshots`、`campaign_budget_ledger` 全部启用并 FORCE store RLS，
使用复合 store/campaign/staff 外键。应用角色不能 DELETE campaign；snapshot 允许 SELECT/INSERT，
ledger 在 Item 7 只允许 SELECT，数据库 trigger 也拒绝修改或删除证据。组织和门店永远从认证会话
注入，输入契约没有 tenant 字段。

三类写 trigger 都把 staff 字段绑定到 `app.staff_id`，并在数据库内复核该员工是当前
`app.org_id + app.store_id` 的有效 admin；时间戳由数据库覆盖、版本只允许加一、身份字段不可变。
因此伪造 actor、跨店 GUC、非 admin 或倒退时间的 app-role 直写都会失败关闭。

服务端对两写三读都同时检查：

1. 当前会话具备 admin-only `marketing_manage`；
2. 当前门店 `store_features.marketing=true`。

五个 HTTP 入口另共用营销专用固定窗口 limiter，bucket 只由服务端认证会话投影的
`session_id + org_id + store_id` 及读写类别组成。超限在请求体解析、数据库访问和命令/查询总线之前
返回 429 与 `Retry-After`；客户端不能通过提交 tenant 字段切换 bucket。

marketing 默认仍为 `false`。Web 只有在 server-projected `marketing_enabled=true` 时显示导航，但 UI
隐藏不是授权；直接 HTTP 调用仍由 Server 与 RLS 失败关闭。审计仅保存 campaign/snapshot id、版本、
预算、规则/受众摘要和人数，不复制顾客名单。

R4 PIN 复核还绑定完整确认卡、当前 session scope 与发起 action generation。Esc、backdrop、标题栏关闭、
组件卸载或 quick-switch 都会同步失效当前 verify attempt；迟到的 PIN success 不得触发 confirm command。

### 6. 契约冻结与查询边界

新增两写：

- `marketing.campaign.set`
- `marketing.campaign.audience.freeze`

新增三读：

- `marketing.campaigns.list`（最多 50）
- `marketing.campaign.get`（一个活动、最多 20 个摘要）
- `marketing.campaign.audience.preview`（一个聚合结果）

冻结面从 **58/38 → 60/41**。全部 internal、online-only、排除 AI。迁移编号使用 Stage 4.4 的预留
规划：Items 1–4 为 `0054`–`0057`、Item 5 无迁移、Item 6 为 `0058`，本项固定 `0059`；当前独立
分支不伪造其他 Item 的迁移文件，集成时必须按编号顺序合并并重跑 fresh PostgreSQL。

## 安全与锁序

- campaign set：campaign row → budget ledger aggregate；
- audience freeze：campaign `FOR UPDATE` → 固定受众查询 → snapshot insert；
- Item 8 预算写：campaign `FOR UPDATE` → ledger aggregate → ledger insert。

受众摘要不是加密名单，也不能证明实际发放；它只用于同一规则/版本的漂移检测。SHA-256 不含姓名、
手机号或地址。没有原始 recipient list 就不能从 snapshot 反查顾客。

## 不在本片范围

- 批量发券、逐客资格、券 grant、核销、冲正或退款；
- 推荐奖励、团购、邀请关系、反作弊；
- 短信、微信、push、定时任务或 provider 调用；
- 跨店/org campaign、组织级预算或外部营销平台；
- AI/automation、Edge/offline、桌面同步适配或真实设备验收。

## 验收

1. Contracts 冻结 60/41，DSL 深层 strict、窗口/人数/整数预算有界，两写三读不进入 AI。
2. `0059` apply/replay，三表 FORCE store RLS、复合外键、规则 validator、CAS/终态、append-only 与
   并发预算上限在真实 PostgreSQL 通过。
3. Memory/PG handlers 覆盖 feature off、非管理员、跨租户、版本冲突、aggregate-only preview、
   preview 漂移和语义幂等 freeze；业务与 audit 同事务。
4. Owner Web 只在 feature 打开时显示，金额只转换为整数分，R3/R4 续跑只提交 `confirm_ref`，页面
   不显示或缓存 recipient ids；list/preview/command 分别绑定 session scope、输入 authority key 与
   monotonic generation，迟到响应不能跨活动、输入或会话安装确认卡。
5. focused tests、typecheck/lint/build、OpenAPI snapshot 和文件规模门禁通过；正式部署另行取证。

## 后果与否决项

- 得到可审计、可重放、不会暗中发券的营销配置基线；Item 8 可以复用冻结摘要和预算 authority。
- digest-only 设计使后续发券必须重新评估，换来不新增顾客名单副本。
- **否决任意 SQL/字段 DSL**：会形成注入与越权查询面。
- **否决保存完整 recipient rows**：Item 7 不需要新增 PII 副本。
- **否决 set/freeze 顺便发券**：绕过 Item 8 的资格、幂等、核销和冲正协议。
- **否决 org scope 占位**：当前会话没有跨店营销授权。
- **否决可修改预算流水或 snapshot**：会使历史用量和冻结证据不可证明。
