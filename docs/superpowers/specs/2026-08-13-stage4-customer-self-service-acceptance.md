# Stage 4.4 Item 10 顾客自助查询验收记录

- 日期：2026-08-13
- ADR：[ADR-55](../../adr/2026-08-13-adr-55-customer-self-service-orders.md)
- 状态：Item 10 只读订单范围仍有效；其 Item 11 保留边界已由 ADR-56 / Item 11 验收记录取代

## 本片验收口径

| 层         | 必须证明                                                             | 不能替代     |
| ---------- | -------------------------------------------------------------------- | ------------ |
| Contract   | 5 条 R2/PII strict query、62/48 freeze、OpenAPI、AI 排除             | UI 文案      |
| Identity   | 15 分钟哈希会话、tab authority、CSRF、revoke、anti-enumeration、限流 | staff 登录   |
| PostgreSQL | `0061`、feature hard-off、canonical group、RLS/ACL、安全投影         | memory fake  |
| Privacy    | 无手机号/姓名/备注/员工/条码/架位/原因/照片；最小 append-only audit  | 字段遮罩截图 |
| Web        | `/customer` mobile/desktop、订单、整数分票据、件级真实节点           | API 单测     |

## 自动化用例

1. feature off、错误组织/门店/手机号/取件码均返回同一失败，不回显输入。
2. 登录只保存 session/CSRF/tab-authority hash，authority 原文只在当前 tab `sessionStorage`；Cookie 单独
   不构成权限。随机内存 tab nonce 必须通过同源 Web Locks 独占 authority selector；opener/duplicate
   复制的两个 tab 只能一个 resume，另一方失败关闭并重新登录。reload 可重新取得租约；logout 网络请求前
   立即清除本地 authority。
3. 所有 POST 缺失/错误 CSRF 拒绝；登录与 query 分别按账户/source、session/source 限流。Caddy 必须
   将 `desk.manpengan.xyz` 的唯一 `:443` handler exact 绑定三组 API path、Host、专用真实来源覆盖、
   forwarding 删除与唯一 loopback upstream，且 release preflight 使用同一 parser；decoy 不能掩盖真实
   route。仅 loopback peer 可用，伪造或多值
   专用头以及 Forwarded/X-Real-IP 均拒绝。同一 socket 轮换手机号第三次失败进入 429；存在/不存在顾客
   认证都满足统一 500ms 下界。
4. source customer 合并到 target 后，canonical group 内历史订单继续可见；外部 customer 不可见。两个
   各有五个会话的 root 合并时，必须在同一事务把整个组织 canonical group 立即收敛到最多五个 active
   session，下一次登录后仍不得超过五个。`laundry_app` 直接更新 merge 两列必须因 ACL 拒绝；并发 merge/
   login 必须都先等待 org advisory lock，不能先持 customer row lock。
5. 跨 tenant/store/customer 与不存在 UUID 返回相同 unavailable 响应，响应不含被猜 ID。
6. orders/receipt/garments 必须通过 strict Zod；内部字段意外出现时整包失败关闭。
7. 票据只读取现有 order/payment authority，金额均为非负整数分，且完整接受生产账本五种 method（含
   `balance`），不生成第二份 receipt ledger。
8. 衣物当前状态与节点只来自 `garments`/`garment_status_log`；不返回 reason/staff 或预计完成时间。
9. access log 只记 operation/resource/session/subject/time，append-only 且无原始 PII/IP/User-Agent。
10. Web 单列 mobile，900px 以上双栏；登录、订单、票据和件级节点具备语义标题与触摸目标。
11. logout/login 先递增 session generation 并清空全部顾客数据；旧 list/detail/progress 即使延迟完成，
    也不能覆盖另一顾客的新会话状态，且被替换请求的 `AbortSignal` 必须已取消。
12. 用真实 Set-Cookie jar 制造同 tab 旧 login、跨 tab A/B login、logout/resume 乱序；后续 list、detail、
    progress 必须同时匹配 SHA-256 selector Cookie 与 tab authority；迟到 A 的 Set/Clear-Cookie 后 B 仍须
    200 且只返回 B，selector 名不得泄露原始 authority，mismatch 不能清另一合法 tab cookie。
13. fake clock 推进到服务端 `expires_at` 时必须换代、abort 并同步清空 orders/detail/progress、authority 与
    authenticated；迟到响应不能复活数据。
14. OpenAPI 完整含 login/session/logout 的 method、request、selector cookie、CSRF、authority、统一响应、
    各状态 `Cache-Control: no-store` 与实际 Set/Clear-Cookie 副作用；login/session 的 429 与
    `Retry-After` 必须存在，logout 的严格 `{}` body 必须由 route 解析，且共享 read 桶耗尽后仍须 revoke。

## 已被 Item 11 取代的保留边界

- 钱包、次卡、积分、券包、地址与通知偏好现按
  [Item 11 验收记录](2026-08-13-stage4-customer-wallet-acceptance.md) 独立验收；不得继续引用本记录声称其未实现。

## 仍明确保留

- 微信小程序、微信身份、短信/微信通知、支付机构、AI、automation、Edge/offline。
- 公网浏览器实跑、hk-vps migration/marker 与 exact-main CI/部署证据。

以上保留项没有证据时，不得把“可查询既有订单”写成“顾客全功能会员中心已交付”。
