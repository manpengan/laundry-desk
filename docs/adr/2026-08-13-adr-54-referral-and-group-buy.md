# ADR-54：推荐奖励与团购券核销

- 日期：2026-08-13
- 状态：**Proposed（实现候选已落地，待 manpengan 签署）**
- 决策者：manpengan
- 前置：[ADR-41：会员权益与有效期](2026-08-11-adr-41-member-benefits-and-expiry.md)、
  [ADR-52：门店营销活动](2026-08-13-adr-52-store-marketing-campaigns.md)、
  [ADR-53：活动批量发券](2026-08-13-adr-53-campaign-coupon-issuance.md)
- 契约门禁：[ADR-16：边缘运营范围与契约面](2026-07-31-adr-16-edge-operations-scope-ratification.md)
- 影响：Contracts、`0063`、Server marketing/member benefits/order、Owner Web、Cloud 验收

## 背景

Stage 4.4 Item 9 要在既有活动预算、会员券账本和订单应收权威之上补齐两类营销扩展：按真实结清
订单发推荐奖励，以及把外部平台售出的单次团购券核销到门店订单。两类操作都会改变有价值权益或
订单应收，浏览器不能提交奖励金额、预算扣款或最终优惠，重试与并发也不能重复发券或重复核销。

本 ADR 只关闭 Item 9，不实现团购商品销售/退款、推荐关系采集、顾客自助、通知、provider 对账或
反作弊评分平台。

## 决策

### 1. 三条 online-only R4 命令

新增三条命令，不新增查询：

- `marketing.referral.reward.issue`
- `marketing.group_buy.voucher.register`
- `marketing.group_buy.voucher.redeem`

三条命令都要求当前会话的 `marketing_manage`、当前门店 marketing feature 显式开启、专用营销
限流、持久幂等及另一管理员 R4 复核。tenant 只取自会话；AI、Edge 和离线入口全部拒绝。确认卡冻结
完整服务端 authority，二跳重新锁读并逐字段比较，漂移即失败且不产生部分写入。

### 2. 推荐奖励复用既有券账本和活动预算

调用者只提交活动/版本、推荐双方顾客 id、被推荐人的资格订单、奖励券定义和原因。服务端在当前
门店锁读并验证：

1. 活动仍为 scheduled、当前时间仍在半开窗口且版本一致；
2. 两名顾客不同、都未合并/匿名化，且映射到不同的 active 会员账户；
3. 资格订单属于被推荐人、已 closed、已实际付款且余额为零；
4. 奖励券定义仍 active，其版本、面额、最低消费和有效期全部进入确认 authority；
5. 券面额不超过锁后重算的活动剩余预算。

成功事务向推荐人的既有 `coupon_grants` 追加一张券，同时追加一条 `referral_rewards` 和精确相等的
`campaign_budget_ledger`。同一资格订单全局一次，同一活动/被推荐人一次；相同完整语义重试返回原
记录，冲突归因失败。推荐证据冻结首次执行前的 `budget_remaining_before_cents`；相同幂等语义先从
既有证据重建完整 authority，再跳过活动窗口、券状态和剩余预算等可变终态检查，因此预算恰好耗尽、
活动随后结束或券随后退役都能返回原结果。二跳仍必须与首跳冻结 authority 完全一致，任一语义漂移
都失败关闭。锁序固定为 campaign、按 id 排序的顾客/账户、订单、券，避免相反推荐并发死锁。

### 3. 团购券原码不进入服务端

团购券原码必须由外部平台生成并具备足够熵；本系统只能在 Owner Web 本机检查 24–128 字符的
字母数字/连字符串格式及末四位为字母数字，不能从格式证明随机性。Owner Web 随后按以下固定域
生成 SHA-256：

```text
UTF-8("laundry:group-buy:v1" + NUL + trim(raw_code))
```

命令边界只接收 64 位小写摘要；登记另接收展示用末四位。末四位只是人工识别提示，服务端无法从
单向摘要验证它与原码一致，不能参与授权或防伪判断。原码不会进入 HTTP body、pending action、正式
表、审计、事件或响应。摘要按当前门店唯一，平台加外部订单号也唯一；登记有效期必须晚于登记时刻
且不超过五年。由于摘要是核销凭据，它继续按 `secret` 分类并从日志投影移除。

### 4. 核销金额与订单证据由服务端计算

核销只接受摘要、订单 id 和原因。服务端锁券后要求未过期且未被其他订单使用，再锁当前门店订单；
订单必须 open、属于明确顾客、未付款、没有既有折扣，且余额等于应收。实际优惠固定为
`min(face_value_cents, order.original_cents)`，并且不得超过当前应收。一个事务更新订单应收并追加
`group_buy_redemptions`；数据库 trigger 反向验证更新后的订单金额、manual 来源、原始应收快照和券
面额。相同券/订单重放返回原证据，一张券或一个订单都不能出现第二条团购核销。

### 5. PostgreSQL 权威与隐私

expand-only `0063_referral_and_group_buy.sql` 新增 store-scoped `referral_rewards`、
`group_buy_vouchers`、`group_buy_redemptions`。`0061–0062` 为并行开发的 Items 10–11 预留，集成时按
编号一起进入迁移 bundle。三表 FORCE RLS，应用角色仅 SELECT/INSERT，UPDATE/DELETE/TRUNCATE 被
撤销，证据 trigger 只追加。复合 FK、唯一键、整数分 CHECK、deferred referral/预算完整性和安全定义
函数构成最后一道防线。

推荐确认摘要不公开内部会员 account id；团购确认摘要不公开摘要。审计/事件只带非秘密业务引用和
聚合金额，不复制姓名、手机号、地址或券原码。

Owner Web 的 R4 卡片逐字段呈现对应公开 authority。每次请求以会话 scope、动作、活动 id/version
（推荐）及规范化输入 authority 为边界；团购还绑定本机摘要。单调 generation 在会话快速切换、活动
切换、输入变化、重复提交或卸载时立即失效旧请求，迟到的摘要计算或网络响应不得安装确认卡、应用结果
或发出成功/错误提示。

## 验收

1. Contracts freeze 为 65 写 / 43 读；三条新命令 strict、R4、online-only、非 AI/Edge。
2. feature off、权限缺失、跨门店 RLS、无另一管理员复核、错误/过期摘要和限流均失败关闭。
3. 推荐资格、券快照、预算、语义幂等、锁后漂移、精确 ledger 和 deferred completeness 有自动化证据；
   首次发放耗尽预算后，即使活动结束且券退役，完整同语义重放仍只返回原证据且三张账表各一条。
4. 团购登记/核销的唯一性、五年期限、单次消费、订单金额反证、append-only 与摘要投影有自动化证据。
5. Owner Web 提供逐字段 WYSIWYS 复核面，account id、digest 和原始券码均不可见；会话、活动或输入
   变化会让迟到请求失效。原始券码只在本机短暂存在；真实 PostgreSQL 定点门禁通过后才能称为实现
   候选，部署和公网浏览器仍按 exact SHA 单独验收。

## 后果

- 推荐奖励与团购核销都建立在现有会员券、活动预算和订单权威上，不形成平行余额系统。
- 高风险操作增加一次双管理员现场复核；这是有价值权益与订单改价的明确成本。
- 外部平台仅作为来源标签，并负责生成高熵原码；没有 provider API/签名回执时，不能声称完成平台
  结算或防伪联网验真，展示末四位也不能替代该证明。

## 否决的备选

- **否决浏览器提交奖励/优惠金额**：会绕过券定义、活动预算和订单 authority。
- **否决服务端接收或保存原始券码**：R4 pending 表和审计链会扩大 bearer secret 暴露面。
- **否决把团购券建成储值余额**：单次凭证与可分次使用资金的会计语义不同。
- **否决复用普通手工折扣而不留 redemption**：无法证明券只消费一次，也无法安全幂等重放。
- **否决自动发放或 R3 核销**：两类操作都直接改变权益或应收，必须由另一管理员复核。
