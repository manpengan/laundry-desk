# Stage 4.4 Item 11 顾客钱包、权益与自助偏好验收记录

- 日期：2026-08-13
- ADR：[ADR-56](../../adr/2026-08-13-adr-56-customer-wallet-and-preferences.md)
- 状态：实现候选；部署、公网浏览器与 exact-SHA CI 仍须另行刷新
- 取代：Item 10 记录中“钱包、次卡、积分、券包、地址与通知偏好未交付”的保留边界

## 本片验收口径

| 层         | 必须证明                                                                     | 不能替代           |
| ---------- | ---------------------------------------------------------------------------- | ------------------ |
| Contract   | 3 条 customer-only strict query、62/51 freeze、独立 profile mutation/OpenAPI | staff bus          |
| PostgreSQL | `0062`、0050/0051 权威复用、RLS/ACL、canonical CAS 与 portal-owned 地址      | memory fake        |
| Privacy    | 只写自己的偏好/门户地址，证据无地址/收件人/联系电话                          | UI 隐藏字段        |
| Server     | session subject、CSRF、source/session limit、参数化 SQL、no-store、409 CAS   | 客户端 customer id |
| Web        | 钱包/权益只读、门店地址保留、偏好保存、generation/Abort 清 PII               | API 单测           |

## 自动化用例

1. 三条 query 只接受 strict `{}`；profile mutation 拒绝 customer/org/store 及所有员工档案字段。
2. 钱包只从 `member_ledger` 求和，整数分且本金 + 赠款 = 总额；最近流水最多 50，不存在充值/支付写入口。
3. 等级、积分、次卡与券包分别从 0050 snapshot/ledger/allocation/redemption/reversal 派生，按 DB 门店日期
   判定状态；不存在兑换、使用或核销入口。
4. 每次 portal transaction 重新验证 active session、authority hash、feature 和 app org/store/customer；
   跨组织、门店、顾客与 canonical group 读取失败关闭。
5. profile update 先取得 0051 merge 共用 org advisory lock，再按确定顺序锁 customer/preference/address；
   陈旧 `expected_version` 返回 409。
6. 门户只替换 `portal_managed=true` 集合。A→B merge 后 A/B 全部 active 门店地址仍返回；只改偏好也不能
   退休这些地址。地址总数最多 10，canonical group 最多一个默认。
7. `laundry_app` 直接 INSERT/UPDATE/retire/delete portal-owned address 以 ACL/trigger 拒绝；privacy owner
   仍可执行不可逆擦除。
8. access log 对 profile update 只含 address_count/preference/version 和既有 authority 外键/时间，append-only，
   不含地址、收件人、联系电话、手机号、provider payload 或正文。
9. HTTP mutation 必须同时通过 tab authority、selector cookie、CSRF、可信来源、JSON media type、strict body、
   session/source limiter；所有状态响应 no-store，429 有 Retry-After。
10. Web 只显示余额/权益，不渲染充值、支付、积分兑换、次卡使用、发券或核销按钮；通知偏好明确不代表发送。
11. Web 只提交 `source=portal` 地址，门店来源只读；保存成功采用服务端新 version 和 canonical merged list。
12. logout、过期、重新登录/切换 subject、dispose 都换代并 abort 当前请求，立即清空 wallet/benefits/profile、
    地址/偏好和订单 PII；旧响应不得复活。
13. fresh PostgreSQL 从 `0001` 顺序 apply 到 `0062`，并执行真实 session/login/query/profile CAS、RLS、merge
    与 direct DML 行为；migration replay、expand-only guard 和权限矩阵通过。
14. Contracts/DB/Server/Web focused test、lint、typecheck/build、OpenAPI snapshot、diff、size 与 secret scan 全绿。

## 明确保留

- 顾客充值、余额支付/退款、积分兑换、次卡使用、发券/核销和配送下单。
- 微信小程序/微信身份、真实短信/微信 provider、支付机构与送达回执。
- 公网浏览器、hk-vps migration/marker、exact-main CI、部署和正式生产容量证据。

因此本记录只能称为 Item 11 实现候选，不能称为 provider 已通知、支付已接入或正式生产会员中心发布。
