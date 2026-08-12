# Stage 4.4 Item 8 活动券验收记录

- 日期：2026-08-13
- ADR：[ADR-53](../../adr/2026-08-13-adr-53-campaign-coupon-issuance.md)
- 状态：实现候选；定点真实 PostgreSQL 已通过，部署、公网浏览器与 exact-SHA CI 仍须另行刷新

## 本片验收口径

| 层         | 必须证明                                                             | 不能替代           |
| ---------- | -------------------------------------------------------------------- | ------------------ |
| Contract   | 2 写 2 读、62/43 freeze、R4、strict authority references             | UI 表单            |
| PostgreSQL | `0060`、FORCE RLS、grant FK、append-only、exact budget、提交后禁追加 | 定点真库通过       |
| Server     | digest 重评、active-account、服务端 pending authority、漂移失败关闭  | campaign scheduled |
| Web        | 完整券语义复核摘要、首跳 epoch、无旧 preview/select 竞态、两类续跑   | API 单测           |
| 隐私       | 无 recipient 输入/响应/audit/event；不复制姓名/手机号/地址           | SHA-256 本身       |

## 自动化用例

1. issue 输入拒绝 tenant、recipient/customer/account、券面额、人数、预算和未知字段。
2. 非 scheduled、窗口外、版本/snapshot/digest 漂移、券退役、零合格会员或预算不足均不写任何批次。
3. 同 campaign/version/snapshot/coupon 重放返回同一 batch；grant、provenance 和预算各只写一次。
4. 每个 grant 复用 ADR-41 的不可变券快照；batch 最坏预算精确等于券面额乘合格人数。
5. 普通手工券、已付款/关闭/折扣漂移订单不能由营销冲正；成功时恢复订单并只追加 reversal。
6. feature off、非管理员、跨租户、缺另一管理员复核和直接 HTTP 绕过全部失败关闭。
7. 两条 R4 首跳 summary 与 pending authority 同源；发券冻结券版本、名称、最低消费和有效期；二跳
   任一券语义、预算/人数或订单金额漂移时以策略拒绝且不写入。
8. batch 和 provenance 都触发 deferred completeness，批次锁下的人数 cap 拒绝提交后/并发追加。
9. 远程 Owner 可路由既有会员券目录，非 allowlist 的柜台目录查询继续拒绝。
10. Owner 页面只显示服务端 aggregate 摘要；活动/snapshot/券/原因/redemption 变化会递增首跳 epoch，
    deferred response 不得安装旧确认卡，也不接受旧 preview 覆盖新选择。
11. 真 PostgreSQL 双连接证明第二跳等待 campaign lock；第一笔 ledger 提交后，第二跳用新 statement
    snapshot 重算预算并返回 authority drift，而不是成功或 `INVARIANT_FAILED`。数据库 cap 继续兜底。

## 明确保留

- Item 9 推荐奖励、团购核销及反作弊。
- Items 10–11 顾客自助订单/票据/钱包/券包/地址/偏好。
- 定时投放、短信/微信/provider、AI/automation/Edge/offline。
- hk-vps 正式部署、远端 migration marker、public Browser 与 exact-SHA CI。

以上任一保留项没有证据时，不得把“活动券已发放”写成“顾客已经收到通知”或“营销转化已完成”。
