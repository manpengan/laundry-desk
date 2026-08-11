# ADR-38：Cloud 柜台可信计价、支付退款与挂单明细闭环

- 日期：2026-08-11
- 状态：**Accepted**
- 决策者：manpengan
- 前序：[ADR-16：边缘运营范围追认与契约面门禁](2026-07-31-adr-16-edge-operations-scope-ratification.md)、[ADR-37：Cloud Web-first 主交付线与剩余功能顺序](2026-08-10-adr-37-cloud-web-primary-delivery.md)
- 影响：`order.receive`、`order.hold`、`order.get`、计价策略、支付流水查询、退款 Web、衣物明细、PostgreSQL 迁移与 hk-vps 发布

## 背景

阶段 1 已把精确 `main`、PostgreSQL 迁移、Fastify、React Web 与公网验收组成可回滚的
Cloud Web 发布闭环，但柜台核心仍有三组可信性缺口：

1. catalog 单价由服务端读取，折扣、附加费、急件费和运费却仍由浏览器提交金额；设置页的
   “最低消费”只写不读，也没有订单消费者；
2. `payment.refund` 已有 R4、另一管理员 step-up 和只追加流水实现，Web 却没有支付流水
   查询，操作员无法从可信来源选择 `ref_payment_id`；
3. `order.hold` 能保存 draft，但开单页只在 React 内存保留 `draft_id`。颜色、品牌也没有
   Web 输入，瑕疵、随衣附件和件级备注没有持久模型。

ADR-37 要求依次关闭这三个切片，并要求每个切片以真实 PostgreSQL、浏览器与新鲜云行为
验收。ADR-16 同时要求新增命令/查询与合同变更在同一 PR 精确冻结。

## 决策

### 1. 门店计价策略成为独立的服务端权威

新增店级 `store_pricing_policies`，由 `(org_id, store_id)` 唯一定位，保存：

- 固定整数分 `urgent_cents`、`freight_cents`；
- 有稳定 `code`、名称、整数分单价、启用状态和排序号的附加项目录；
- 单调递增 `version`、修改人和修改时间。

新增以下契约：

- `pricing.policy.get`（R0 query）：只返回当前认证门店的策略；客户端不能指定 org/store；
- `pricing.policy.set`（R5 command）：`settings_admin` + 另一管理员现场 step-up，整份替换当前
  门店策略并写审计；附加项 code 必须唯一。

不复用 org 级通用 `settings` 表保存店级策略。这样不会依赖可猜的设置键，也不会让当前门店
会话读取或修改同组织另一门店的计价数据。

`order.receive` 与 `order.hold` 调整为只接收业务选择：

- `discount_cents` 是订单级固定整数分；非零时调用者必须有新的 `order_discount` 权限，当前
  只授予 admin，且仍满足 `0 <= discount <= original`；
- `urgent`、`freight` 只接受布尔开关，金额从当前门店策略读取；
- 每件衣物只提交附加项 code，服务端在同一命令事务中解析启用目录并求和；未知、重复、停用
  code 一律拒绝；
- 历史 `addon_cents`、`urgent_cents`、`freight_cents` 字段暂保留为仅兼容输入，但服务端忽略，
  防止旧队列因严格 schema 直接损坏，同时彻底取消其定价权威。

服务端继续从 catalog 解析基础单价，并以 domain 的固定公式计算唯一结果：

```text
original = sum(catalog_unit_price * qty)
addon    = sum(each selected server addon price)
payable  = original - discount + addon + selected_urgent + selected_freight
```

订单快照保存五段金额、策略版本、急件/运费选择以及附加项 code/name/price 快照。浏览器预览
使用 `pricing.policy.get`，但提交后的服务端结果始终是唯一权威。

### 2. 支付流水查询与退款只使用服务端引用

新增 `payment.ledger.list`（R2 query），输入只有 `order_id`，返回按不可变 `ledger_seq` 排序的
支付、补缴、退款和红冲投影。对每条原支付由服务端给出当前 `active` 与
`refundable_cents`；浏览器不得自行从金额列表推断可退余额。

退款 Web 只允许从 `refundable_cents > 0` 的原支付选择，自动提交该行的 `payment_id` 与
`method`，要求操作员填写正整数分金额和原因。实际写入继续调用既有 `payment.refund`：

- 服务器在行锁下再次核对原流水、付款方式和可退余额；
- R4 confirmation card 冻结所见即所得参数；
- 当前登录人不能自核，必须由另一位 admin 输入 PIN；
- 成功只追加 refund row，不更新或删除历史流水。

`payment.ledger.list` 不进入只读 AI 工具投影，退款命令继续是任何自动化策略都不可授权的
红线操作。

### 3. 件级衣物明细与可召回 draft 使用持久真源

`order.receive` / `order.hold` 的每个计价行新增与 `qty` 等长的 `garments` 数组。每个元素可含：

- `color`、`brand`；
- 有界字符串数组 `defects`、`accessories`；
- 有界 `note`；
- 有界且不重复的 `addon_codes`。

`order_lines.garment_details_json` 保存完整件级草稿与附加项价格快照；正式开单时同时把
颜色、品牌、瑕疵、随衣附件和备注投影到对应 `garments` 行。旧客户端不传 `garments` 时，
服务端按既有 line 颜色/品牌生成兼容的空明细，但新 Web 始终提交逐件数组。

`order.get` 升级为订单详情与 draft 恢复的共同读模型，返回：

- 客户、订单备注、完整五段金额、策略版本和急件/运费选择；
- 可编辑 order lines 与逐件明细；
- 正式订单的 garments 状态、条码、架位及件级属性。

开单页通过已有 `order.list {status: "draft"}` 获取有界挂单列表，再以 `order.get` 载入服务端
持久草稿并恢复 `draft_id`。刷新、重新登录或换浏览器实例均不依赖 React 内存。已经 open、
cancelled 或不存在的 ID 不作为可编辑 draft 恢复；再次 hold/receive 时服务端仍核对该 ID 的
当前状态。

### 4. 契约冻结与版本

本 PR 明确修改 `packages/contracts/test/m2-freeze.test.ts`：

- 新增 command：`pricing.policy.set`；
- 新增 queries：`pricing.policy.get`、`payment.ledger.list`；
- `order.receive`、`order.hold` 升为 `0.4.0`；
- `order.get` 升为 `0.3.0`；
- `M2_CONTRACT_COMMAND_NAMES` 从 41 增至 42，query names 从 25 增至 27；
- 新查询不自动扩大 `M2_READ_ONLY_AI_DEFINITIONS`。

不新增人工单价覆盖、退款新命令、draft 丢弃命令、照片预上传、会员折扣或阶段 3 能力。

### 5. `0046 -> 0047` 是旧代码兼容的纯扩展迁移

新增 `0047_cloud_counter_trust.sql`，只做以下扩展：

- 创建带店级 RLS/FORCE RLS 的 `store_pricing_policies`；
- 为 `orders` 增加带默认值的策略版本与急件/运费选择列；
- 为 `order_lines` 增加带默认空数组的 JSONB 明细列，并为历史行生成兼容明细；
- 为 `garments` 增加带默认空数组的瑕疵/附件列及 nullable note。

迁移不删除、重命名或收窄旧列，不改变旧 insert 所需字段；0046 代码会忽略新表/新列并可在
失败切换后继续运行。因此发布允许保留 0047 数据库并只切回 0046 代码，不自动降级数据库。
发布策略必须同批新增该精确 compatibility transition 与 PostgreSQL 16 golden catalog
fingerprint；未知 head 或 catalog 漂移继续失败关闭。

## 验收

三个切片依次建立 checkpoint，最后才进入一次集成 PR 与一次 hk-vps 发布：

1. 计价：合同负例、权限/step-up、设置读写、客户端伪造金额无效、未知附加项失败、真实 PG
   同事务金额与审计、浏览器设置及开单；
2. 流水/退款：domain 可退投影、query 租户隔离、R4 双管理员 Web、超额/错误 method/重复
   confirm 失败、真实 PG 只追加与余额复算；
3. 明细/挂单：件数一致性、字段边界、PG round-trip、刷新后列表召回、再次暂存/转 open、正式
   garments 属性映射。

最终仍须完整 `workspace-check`、required `real-postgres`、Browser 回归、精确 merge-SHA 主干
CI、`0047` 两阶段发布、API/Cloud Chromium/DB/catalog/审计/清理新鲜证据。云环境只使用合成
数据，不因本 ADR 升级为生产 SaaS。

## 后果

- 浏览器不再能通过提交四段已计算金额改变订单应收；门店配置、catalog 与附加项解析都在
  同一服务端命令事务内完成。
- 退款入口第一次能从不可变流水选择可信引用，并复用既有双管理员 R4 权威。
- draft 第一次可跨页面刷新恢复完整逐件输入，正式衣物也保留可查询的接收属性。
- 订单输入与读模型变宽，迁移和 Web 状态管理增加；通过有界数组、严格 schema、版本化合同、
  兼容默认值和真实 PG/Browser 门禁控制风险。

## 否决的备选

- **继续接收客户端 addon/urgent/freight 金额**：设置仍无权威，伪造请求可改应收，否决。
- **把店级策略写进 org 级通用 settings key**：同组织跨店读取/修改边界含混，否决。
- **退款时让操作员手填 payment UUID**：容易引用错误流水且无法所见即所得，否决。
- **Web 自算可退余额**：并发退款后会过期，服务端仍需重算，否决。
- **只把挂单放 localStorage**：无法跨设备/会话验证状态，也会恢复过期定价，否决。
- **draft 先生成正式 garments 或 payment**：会污染件状态、营业收入与只追加账本，否决。
