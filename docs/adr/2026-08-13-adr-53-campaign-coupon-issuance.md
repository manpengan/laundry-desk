# ADR-53：活动批量发券、服务端资格与核销冲正

- 日期：2026-08-13
- 状态：**Proposed（实现候选已落地，待 manpengan 签署）**
- 决策者：manpengan
- 前置：[ADR-41：会员权益与有效期](2026-08-11-adr-41-member-benefits-and-expiry.md)、
  [ADR-52：门店营销活动](2026-08-13-adr-52-store-marketing-campaigns.md)
- 契约门禁：[ADR-16：边缘运营范围与契约面](2026-07-31-adr-16-edge-operations-scope-ratification.md)
- 影响：Contracts、`0060`、Server marketing/member benefits、Owner Web、Cloud 验收

## 背景

ADR-41 已有组织级固定金额券定义、不可变 grant、订单原子核销和只追加冲正；ADR-52 已有当前门店
campaign、digest-only 冻结受众和整数分预算上限。缺口是两者之间的权威连接：浏览器不能提交名单、
优惠金额或预算扣款，重试不能重复发券，冻结后名单变化也不能悄悄发给另一批顾客。

本 ADR 只关闭 Stage 4.4 Item 8。它不新建第二套优惠券、不复制姓名/手机号，不发送通知，也不把
campaign 配置成功冒充为顾客已获得权益。

## 决策

### 1. 只接受权威引用，资格由服务端重算

`marketing.campaign.coupons.preview` 和 `marketing.campaign.coupons.issue` 只接受：

- 当前门店 campaign id 与精确 expected version；
- 该版本的冻结 snapshot id；
- 组织级 coupon definition id；
- 写命令另带 1–256 字符原因。

输入没有 tenant、customer/account/recipient id、人数、券面额、有效期或预算金额。服务端读取
scheduled campaign，要求数据库当前时间落在半开窗口 `[starts_at, ends_at)`，再按 ADR-52 的固定
SQL 重评同一受众。重新计算的 digest 和人数必须与 snapshot 完全一致，否则返回漂移失败，不能
使用旧名单继续发券。

重评后的候选再关联组织级 `member_accounts`。只有 `status=active` 的会员账户合格；无账户、冻结或
关闭账户只计入 aggregate 排除数，不自动开户、不写 grant。coupon definition 必须仍为 active。
preview 只返回冻结人数、合格/排除人数、券版本、名称、编码、面额、最低消费、有效期、最坏预算、
剩余预算和摘要，不返回任何主体 id；这些影响 grant 语义的可变字段必须全部进入服务端确认 authority。

### 2. 批次有界、语义幂等并复用既有券账本

单批继续受 ADR-52 的 500 人上限约束。语义键固定为：

```text
org + store + campaign + campaign_version + snapshot + coupon_definition
```

相同键重放返回同一 batch，不重复 grant 或预算流水。一个事务内按以下顺序执行：

1. 单独锁 campaign，再在下一条语句按同一活动重算已用预算，复核状态、窗口和版本；
2. 锁读 snapshot 与 coupon definition，逐字段复核 digest、券版本和完整 grant 语义；
3. 重评受众并锁合格的 active member accounts；
4. 计算 `coupon_discount_cents × eligible_count`，以整数分最坏值检查剩余预算；
5. 追加 `campaign_coupon_batches`；
6. 批量追加 ADR-41 的 `coupon_grants`，冻结 code/name/discount/minimum/expiry；
7. 追加 `campaign_coupon_grants` provenance 和一条精确 `campaign_budget_ledger`；
8. 命令总线在同一事务追加 audit，提交后才发布事件。

任一步失败整笔回滚。`campaign_coupon_batches` 只保留 aggregate 与配置快照；逐账户关系只通过既有
coupon grant 和最小 provenance 表表达，不新建 customer 名单副本。预算在发放时按可能承担的最大
优惠占用，不因未核销、过期或冲正返还；这样预算始终是营销承诺上限，不会被反复冲正后重用。

### 3. 核销沿用 ADR-41，人工冲正保留双向证据

活动券仍使用 `member.asset.consume` 的服务端订单核销：同顾客、open、未收款、无已有折扣、满足
最低金额才可原子更新订单并追加 `coupon_redemptions`。客户端不能提交优惠金额。

新增 R4 `marketing.coupon.redemption.reverse` 只接受 redemption id 和原因，并且只允许属于
`campaign_coupon_grants` 的核销。服务端锁订单，要求订单仍为 open、未收款且当前折扣精确等于原
redemption；随后恢复订单 discount/payable/balance，并追加既有
`coupon_redemption_reversals`。原 redemption 和 grant 永不更新或删除。重复冲正返回同一 reversal
且 `changed=false`；取消订单产生的既有冲正同样可作为幂等终态读取。

已经付款、关闭、金额漂移、普通手工券或不存在的 redemption 一律失败，不猜测修复。订单取消的
ADR-41 原子冲正路径继续有效，不需要改写为营销命令。

### 4. 风险、权限、限流和租户

两条写命令都固定为 R4、online-only、UI-only，必须由当前管理员发起并由另一管理员 step-up 复核；
统一命令总线负责持久幂等、确认卡、速率限制、事务 audit 与失败回滚。两条聚合查询为 R2，全部排除
AI/automation/Edge/offline 投影。

R4 首跳必须在租户事务中生成服务端 pending authority：发券冻结 campaign version、snapshot digest、
券快照、合格/排除人数和预算；冲正冻结 redemption、grant、order、原优惠金额和当前冲正状态。Owner
页面只渲染该服务端 summary。二跳在持有相同锁后重新计算并逐字段比对，任何人数、预算、券、订单或
金额漂移都以 `POLICY_DENIED` 失败关闭，不能用客户端预览替代确认卡权威。Owner 首跳同时绑定
generation 与当前 authority key；活动、snapshot、券、原因或核销输入一旦变化，迟到响应不得打开确认卡。

所有入口同时要求 `marketing_manage` 与当前门店 `marketing=true`。组织、门店和操作者只从认证会话
注入。远程 Owner surface 仅开放这四个固定名字；RLS 对 batch/provenance 强制 `org_id+store_id`。

### 5. PostgreSQL 证据与权限

expand-only `0060_campaign_coupon_batches.sql` 新增两张 store-scoped 表：

- `campaign_coupon_batches`：冻结活动、受众、券定义版本及完整 grant 语义、人数、预算、操作者与原因；
- `campaign_coupon_grants`：把每个既有 coupon grant 绑定到 batch/campaign/snapshot。

两表 FORCE RLS、复合外键、SELECT/INSERT-only，触发器拒绝 UPDATE/DELETE。batch trigger 再次校验
活动窗口、snapshot 和券定义快照；provenance trigger 校验 grant 的账户、定义、金额与门店。`0060`
收紧 ADR-52 的 budget trigger：`coupon_issue.source_id` 必须是同活动 batch，金额必须精确等于 batch
最坏预算，再在 campaign row lock 下检查总上限。deferred completeness trigger 在提交点要求 provenance
数量精确等于 batch 人数且恰有一条同额预算流水，不能留下“已建批次但少发券/未占预算”的半成品。
batch 与每条 provenance INSERT 都注册该延迟门禁；provenance 写入还必须先 `FOR UPDATE` 锁 batch，
并在插入前检查已映射数不得达到 `granted_count`。因此完整批次提交后不能再追加来源记录，并发追加也
不能绕过人数上限。

应用层不得把 ledger 聚合塞进 `campaign FOR UPDATE` 同一语句：必须先取得 campaign row lock，再用下一条
`SELECT` 读取已提交 ledger。这样等待并发发券的二跳会在前一事务提交后取得新的 statement snapshot，
按最新剩余预算触发 authority drift；数据库 budget cap 仍作为最终兜底。

既有 `coupon_grants`、`coupon_redemptions`、`coupon_redemption_reversals` 的 append-only ACL 不放宽；
没有 UPDATE/DELETE 券流水的业务路径。

### 6. 契约与 Owner Web

新增两写：

- `marketing.campaign.coupons.issue`
- `marketing.coupon.redemption.reverse`

新增两读：

- `marketing.campaign.coupons.preview`
- `marketing.campaign.coupon_batch.get`

冻结面从 **60/41 → 62/43**。Owner 营销页从活动详情读取最多 20 个冻结 snapshot，从既有会员权益
catalog 读取 active coupon definitions；用户先看 aggregate 资格/预算，再发起 R4 复核。页面不接收、
缓存或展示 recipient ids。独立冲正卡接受既有核销 ID 和原因，展示订单与冲正金额后完成 R4 复核；
后续仍可在订单详情增加可发现入口，但当前不需要裸 SQL 才能使用命令。
远程 Owner allowlist 同批开放只读 `member.benefit_catalog.get`，确保非 commissioned store 的活动页也能
取得既有券目录；其他柜台目录查询仍保持拒绝。

## 锁序与失败语义

- 发券：campaign `FOR UPDATE` → 锁后 budget ledger 重算 → snapshot/coupon `FOR SHARE` → active accounts `FOR UPDATE` →
  batch → coupon grants/provenance → budget ledger → audit；
- 冲正：通过 redemption 锁定 order `FOR UPDATE` → 重新读取当前 redemption/provenance/reversal →
  order restore → reversal → audit。

受众漂移、资格为零、预算不足、过期窗口、券退役、订单已付款或审计失败都不会留下部分批次或部分
订单修复。跨租户 id 在应用查询和 RLS/复合外键双层失败关闭。

## 不在本片范围

- 推荐奖励、团购券码、邀请反作弊或营销归因；
- 通知发送、定时发放、provider、微信卡包或支付退款；
- 顾客自助券包、地址、通知偏好；
- 跨店/org campaign、预算返还或可叠加/品类券；
- AI/automation、Edge/offline、桌面同步或真实外部平台验收。

## 验收

1. Contracts 62/43，输入深层 strict，写为 R4，查询不进入 AI；无 recipient/amount 输入面。
2. `0060` apply/replay、FORCE store RLS、复合 FK、append-only ACL、精确 budget source 与迁移 inventory。
3. Memory/PG 覆盖 digest 重评、active-account 资格、券版本/最低消费/有效期与预算 authority 漂移失败、
   双连接锁后 ledger snapshot、语义重放、批量 grant/provenance/ledger 同事务、完整批次禁止追加，
   以及冲正订单恢复和 append-only reversal。
4. Owner Web 展示 snapshot/coupon 选择、aggregate 资格、整数预算、核销冲正卡和另一管理员复核，不泄露名单。
5. focused test、lint、typecheck、build、OpenAPI snapshot 与文件规模门禁通过；真实部署另行取证。

## 后果与否决项

- 活动发券成为既有会员券账本的受控生产者，而不是第二套资产系统。
- 最坏值预算偏保守，但不会因核销率预测错误而超出店主上限。
- **否决客户端 recipient ids/人数/金额**：可越权发券和绕过预算。
- **否决保存 campaign customer 名单**：制造不必要的 PII 副本。
- **否决更新 grant/redemption 表示冲正**：会抹掉原始优惠证据。
- **否决冲正返还 campaign 预算**：同一承诺可被反复重用并突破上限。
- **否决普通员工或 R3 批量发券**：批量有价值权益必须另一管理员复核。
