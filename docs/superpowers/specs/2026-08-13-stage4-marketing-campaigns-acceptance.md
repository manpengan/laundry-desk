# Stage 4.4 Item 7 营销活动验收记录

- 日期：2026-08-13
- ADR：[ADR-52](../../adr/2026-08-13-adr-52-store-marketing-campaigns.md)
- 状态：实现候选；部署、真实 PostgreSQL 和公网浏览器证据必须另行刷新

## 本片验收口径

| 层         | 必须证明                                                                                 | 不能替代                  |
| ---------- | ---------------------------------------------------------------------------------------- | ------------------------- |
| Contract   | 2 写 3 读、60/41 freeze、深层 strict DSL、整数分/时间/人数上限                           | 文档清单                  |
| PostgreSQL | `0059` apply/replay、FORCE store RLS、CAS、terminal、append-only、预算并发锁             | memory test               |
| Server     | feature 与 admin permission 双门禁、会话 tenant、preview 重算、digest freeze、audit/幂等 | Web 隐藏                  |
| Web        | feature-on 导航、完整权威确认卡、跨会话/输入旧响应隔离、confirm_ref 续跑                 | API 单测                  |
| 边界       | 无 recipient/姓名/手机号副本，无发券/通知/provider                                       | campaign 状态为 scheduled |

## 自动化用例

1. DSL 任意额外 key、未知 kind、非法/重复 tier id、越界 days/recipient/budget 全拒绝。
2. 创建必须 version 0 且无 id；更新必须 id + 正版本；旧版本、改 code、取消后或结束后更新失败。
3. preview 排除 merged/anonymized 顾客，订单只看当前 store，结果不含 customer id。
4. freeze 锁内重算；digest/人数/version 漂移不写 snapshot/audit；精确重放返回同一语义 snapshot。
5. Item 7 的 app role 对 budget ledger 仅 SELECT，直接 INSERT 由 ACL 拒绝；snapshot/ledger
   UPDATE/DELETE 双层拒绝，预算锁与写路径留给 Item 8 的受控事务。
6. marketing 默认 false；feature off 或普通员工访问两写三读均失败，不能靠直接 HTTP 绕过。
7. 高预算 set 升 R4；二跳只提交服务端 `confirm_ref`，不由浏览器重算或重传原始权威。
8. set/freeze pending summary 完整、无 PII；任一预算/窗口/规则/版本/digest 漂移均拒绝二跳。
9. app-role 伪造 staff、跨 store GUC、非 admin、版本跳跃或倒退时间均由 PostgreSQL trigger 拒绝。
10. A→B 活动切换、编辑输入、session/store quick-switch 后，旧 list/preview/command 响应均不得回填。
11. 同一营销命令 idempotency key 的精确首跳重试复用同一确认卡；参数或服务端 authority 漂移失败
    关闭，数据库唯一索引保证并发重试不能生成多张卡。
12. 两写三读均在 body/DB/bus 前走 session/org/store 专用 limiter；超限返回 429 与 Retry-After。
13. PIN verify pending 时 Esc、backdrop、标题栏关闭、卸载或 session/store 切换后即使迟到成功，也不
    发送 confirm command；提交前再次核对 pending ref、完整 authority、scope 与 action generation。

## 明确保留

- Item 8 的代码候选现由 [ADR-53](../../adr/2026-08-13-adr-53-campaign-coupon-issuance.md) 与
  [独立验收记录](2026-08-13-stage4-campaign-coupons-acceptance.md)承接；在其真实 PostgreSQL、CI 和
  部署证据形成前，本记录仍不能把 Item 7 的冻结摘要称为已发券。
- Item 9 的推荐奖励与团购。
- 定时投放、短信/微信/provider、AI/automation/Edge/offline。
- hk-vps 正式部署、远端 migration marker、public Browser 与 exact-SHA CI。

以上任一保留项没有证据时，不得把“活动已保存/受众已冻结”写成“优惠券已发放”或“营销已触达”。
