# ADR-41：会员等级、积分、次卡、优惠券与权益有效期

- 日期：2026-08-11
- 状态：**Accepted**
- 决策者：manpengan
- 前序：[ADR-17：会员储值](2026-07-31-adr-17-member-stored-value.md)、
  [ADR-22：充值赠送与本金退款](2026-08-01-adr-22-member-stored-value-phase-2.md)、
  [ADR-25：会员账户生命周期](2026-08-07-adr-25-member-account-lifecycle.md)、
  [ADR-37：Cloud Web 主交付](2026-08-10-adr-37-cloud-web-primary-delivery.md)
- 影响：会员契约、组织级权益账本、订单折扣、Web 顾客/订单/设置页、Cloud 验收

## 背景

现有会员线已经交付组织级储值账户、只追加本金/赠款账本、充值赠送、本金退款和
active/frozen/closed 生命周期，但还没有等级、积分、次卡或优惠券。旧产品设计中的“会员资产
卡”也只显示储值，不能把充值赠送档位当作完整会员体系。

这四类权益共享顾客与会员账户，但不是资金账本：积分和次数没有现金退款权，券的优惠必须由
服务端计算，权益过期也不能静默没收 ADR-17/22 已冻结的储值本金或赠款。

## 决策

### 1. 继续以组织级会员账户为权益主体

等级、积分、次卡和券都绑定既有 `member_accounts`，不新建第二套顾客身份，也不接受客户端
org/store。资产可在同组织授权门店使用；每笔授予、消费或核销仍记录实际操作门店与职员。

账户为 `frozen` 或 `closed` 时禁止积分领取/兑换、次卡/券授予与消费。顾客合并继续沿用
ADR-17/25：单侧账户迁移，双账户拒绝，不自动求和权益。

### 2. 有效期不作用于储值资金

会员等级可配置 `valid_until`；积分授予批次、次卡和券各自冻结 `expires_on`。到期状态在
服务端日期下派生，历史行不删除、不回写成另一种资产。

`member_ledger` 的本金和赠款**没有自动到期**。任何储值结清仍只能走 ADR-22/25 的受权退款
或原子关户。这样不会用一个产品有效期暗中改变预付资金退款权。

会员等级到期只让等级显示为 expired，不会让尚未到自身期限的积分、次卡或券失效；每类资产
按自己的有效期裁决，避免一个日期产生级联没收。

### 3. 统一权益定义管理，但保持类型化表结构

新增 R3 管理命令 `member.benefit_definition.upsert`，输入是严格判别联合：

- `tier`：code、name、level、active/retired；
- `points_policy`：每满多少整数分赠多少积分、1–3650 天有效期、active/retired；组织内仅一条；
- `punch_type`：code、name、总次数、有效天数、active/retired；
- `coupon_type`：code、name、固定整数分优惠、最低订单金额、有效天数、active/retired。

定义创建使用 `expected_version=0`，更新必须携带精确 id/version；陈旧版本整体失败。既有已发
资产保存名称、code、额度/次数和到期快照，后续改价或停用不追溯重估。

发放或积分计算读取 active 定义时必须持有共享行锁，使并发退休/改版与本次发放串行；定义
管理审计按判别类型保存全部影响权益的非敏感规则字段、版本、状态与 note，不能只记录“版本变了”
而无法还原当时规则。

只读 `member.benefit_catalog.get` 最多返回每类 50 条，供设置页与发放表单使用。定义管理只授予
`member_rule_write`，不进入 AI 只读投影。

### 4. 等级由管理员显式升级或延期

`member.membership.set`（R3）以 `account_id + expected_version` 做 CAS，设置或清除 tier 与
`valid_until`，并要求 1–256 字符原因。服务端拒绝 retired tier、过去日期、冻结/关闭账户和
陈旧页面。等级本片只表达身份/到期展示，不自动改订单价格；等级折扣属于阶段 3.4 的折扣政策。
必填原因随会员等级变更写入不可变审计，后续覆盖当前等级时仍可追溯每次裁决。

### 5. 积分由已结清订单让服务端计算

`member.points.earn`（R2）只接受 account/order id。服务端锁定同门店订单，要求订单顾客与
账户一致、订单 closed 且余额为 0，并按当前 active points policy 与订单实际 `paid_cents`
计算 `floor(paid_cents / unit_cents) * points_per_unit`。同一账户/订单最多一笔 earn；响应重试
不会重复赠分，规则后续变化也不重估历史。

积分 credit 保存独立到期日。`member.points.redeem`（R3）接受正整数积分和原因，按最早到期
批次优先分配；只追加 debit 与 allocation，过期或不足整笔拒绝。可用积分只由未到期 credit
减去 allocation 派生，不保存可直接改写的余额。

管理员 R4 退款属于例外资金裁决，不自动追溯扣回已授积分；若以后需要退款追分，须另行定义
负积分、已兑换积分债务和对账规则，不能在本片猜测。

### 6. 次卡和券使用不可变发放快照

`member.asset.grant`（R3、管理员）按 `asset_kind=punch|coupon` 发放 active 定义并冻结到期
日期与权益快照。

`member.asset.consume`（R2、在线）有两种严格输入：

- punch：card id、1–100 次和原因；锁卡后按只追加消费行计算剩余次数，禁止超用或到期使用；
- coupon：grant id、order id；锁券与订单，要求同顾客、订单 open、未收款、没有既有折扣，
  且券未过期/未核销。优惠为 `min(snapshot_discount, order_gross)`，满足最低金额后，在同一事务
  更新订单 `discount/payable/balance` 并追加唯一 redemption。

一张券最多核销一次，一个订单最多一张券。券不与人工折扣叠加，也不接受客户端优惠金额。
订单已经收款、进入其他状态或顾客不匹配时整笔失败；不会出现“券已用但订单未减”或反向半写。

这里的“已核销”指没有冲正行的 active redemption。若 open 订单随后取消，取消事务必须同时追加
唯一、不可变的 `coupon_redemption_reversals`，保留原核销证据并把券恢复为可用于另一张订单；
订单取消、冲正与总线审计任一失败时整笔回滚，不允许删除或改写历史 redemption。

除定义配置外，等级变更、积分领取/兑换、次卡或券发放/消费都属于当前营业日业务写入：写前
获取门店营业日锁并在同一事务重查 `shift.close`，已闭店统一返回 `SHIFT_CLOSED` 且不改变权益或
订单。Web 对每次命令发送 UUID 幂等键；网络中断、HTTP 5xx、事务或事件派发结果不确定时，
相同命令重试继续使用原键，只有成功或明确业务/校验拒绝才释放。确认续跑沿用第一跳的同一键，
Server 同时校验 header/envelope 一致性。

### 7. 统一会员资产查询与 Web 入口

`member.benefits.get` 按 customer id 返回：会员等级/有效期/version、可用及累计积分、最近积分
流水、次卡和券。默认隐藏已到期且已耗尽资产，可显式请求有界历史；严格拒绝未知字段与超过
50 行的数组。

顾客页展示并操作等级、积分、次卡和券；设置页维护定义；订单详情只在 closed 订单提供积分
领取，只在 open/未收款/无折扣订单提供可用券核销。错误、空态和到期态必须显式显示。

### 8. 契约、迁移与回滚边界

新增 6 commands / 2 queries，冻结总面从 44/30 增至 **50/32**：

- commands：`member.benefit_definition.upsert`、`member.membership.set`、
  `member.points.earn`、`member.points.redeem`、`member.asset.grant`、
  `member.asset.consume`；
- queries：`member.benefit_catalog.get`、`member.benefits.get`。

两条查询均不进入 AI 投影；全部命令 `offline_mode=denied`。同批更新 `m2-freeze.test.ts`、
OpenAPI、CHANGELOG 和验收记录。

新增含 12 张组织级 RLS 表的 expand-only `0050_member_benefits.sql`。0049 代码忽略新表，订单只沿用既有金额列，因此
代码回滚可保留 0050；但旧代码不会提供权益查询/核销。不得把数据库可回滚兼容冒充业务发布完成。

## 验收

1. 契约严格拒绝客户端租户、金额/积分越界、无效联合、陈旧 version 与多余字段；freeze 50/32。
2. 内存和真实 PostgreSQL 证明 RLS、跨组织隔离、定义 CAS/退休并发锁、账户状态、闭店门禁、
   到期边界、积分幂等与 FIFO 分配、次卡并发不超用、券核销/取消冲正/再使用、审计同事务及
   失败回滚。
3. Browser 覆盖设置定义、顾客升级/延期、订单积分、次卡发放/消费、券发放与未收款订单核销，
   并证明浏览器不提交积分或优惠金额；HTTP 回归证明网络及结构化 5xx 后重试沿用同一幂等键。
4. workspace、迁移 replay、golden catalog、PR/精确 SHA CI 和 hk-vps Cloud 验收继续分层。

## 后置

- 实体卡号、制卡/补卡介质、支付机构、跨组织转赠与双会员账户自动合并；
- 等级自动升降、等级折扣、复杂券叠加/品类范围、活动批量发券与营销 campaign；
- 退款自动追分、负积分债务和真实 provider 联动。

## 否决的备选

- **让会员到期清空储值**：改变预付资金退款权，否决。
- **把积分混进资金账本**：单位和退款语义不同，否决。
- **客户端提交积分或券金额**：可任意赠送或折扣，否决。
- **券核销与订单改单分两次提交**：会留下半完成状态，否决。
- **修改定义后重估已发资产**：破坏历史快照和顾客预期，否决。
