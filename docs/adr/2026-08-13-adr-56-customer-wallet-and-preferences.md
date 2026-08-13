# ADR-56：顾客自助钱包、权益、地址与通知偏好

- 日期：2026-08-13
- 状态：Proposed
- 决策者：manpengan
- 实现负责人：Codex
- 影响：Contracts、`0062`、Server customer portal、responsive Web、OpenAPI、Cloud 验收

## 背景与范围

ADR-55 / Item 10 已建立独立顾客会话和订单、票据、衣物进度只读面。Item 11 在同一短会话内补齐
储值钱包、会员等级、积分、次卡、券包以及顾客可自主管理的地址和通知联系偏好。0032、0050 与
0051 已分别拥有资金账本、虚拟权益和员工维护档案；门户不能复制第二套 authority，也不能把内部
员工资料写面开放给公网顾客。

本片不增加顾客充值、余额支付、退款、积分兑换、次卡使用、优惠券核销或发券入口；这些动作继续只由
现有柜台策略、服务端事务、员工权限和必要的复核控制。通知偏好只表示顾客希望通过哪种方式联系，
不表示短信、微信或其他 provider 已经发送或送达。

## 决策

### 契约与 HTTP 边界

新增三条 dedicated customer query：

- `customer.self_service.wallet.get`：钱包本金、赠款、总余额和最近 50 条权威流水；
- `customer.self_service.benefits.get`：等级、当前可用积分、最多 50 张次卡和最多 50 张券；
- `customer.self_service.profile.get`：canonical group 全部 active 地址与有效通知偏好。

三条 query 均为 R2/PII、online-only、strict 空输入并排除 AI。freeze 从 **62/48 → 62/51**。
不新增 staff-bus command。唯一写面是 `POST /api/v2/customer/profile`，body 仅含
`expected_version`、`preferred_contact` 和最多十条门户管理地址；strict schema 拒绝
`customer_id`、org、store、姓名、手机号、折扣、豁免、identifier、service note 或会员账本字段。
服务端只从 authority-selected 顾客 session 注入组织、门店和 canonical customer。

所有读取和写入继续要求 tab authority、authority-selected HttpOnly session Cookie、double-submit
CSRF、可信来源、session/source 限流和 15 分钟过期。全部响应 `Cache-Control: no-store`。写入用
`expected_version` CAS；陈旧版本或与门店地址边界冲突统一返回 409，不回显地址或被猜 subject。

### 资金与权益只读投影

`0062_customer_wallet_and_preferences.sql` 只建立 security-invoker/security-barrier portal views：

- 钱包余额由 0032 `member_ledger` 的本金/赠款 signed delta 求和，金额保持整数分；
- 等级读取 0050 immutable membership snapshot，并以数据库当前门店日期判断有效期；
- 可用积分只计算未过期 earn credit 减去既有 allocation；
- 次卡剩余次数来自 issued snapshot 减 immutable usage ledger；
- 优惠券状态来自 grant、redemption 与 reversal authority。

门户没有任何资金或权益写函数。`laundry_app` 既有柜台权限不因 portal view 扩大；跨 org、store、
customer 或 canonical group 的读取仍由 FORCE RLS、session transaction validation 和 view predicate
共同失败关闭。匿名化或 feature 关闭会使投影不可用。

### 门户地址所有权与 canonical merge

0051 `customer_addresses` 增加向后兼容的 `portal_managed boolean default false`。既有和员工新增地址均为
门店管理；门户 mutation 只能退休并重建 canonical group 内 `portal_managed=true` 的集合，绝不能因
只改通知偏好或保存门户地址而退休门店/来源 profile 地址。普通 `laundry_app` DML 若插入、修改、退休
或删除 portal-owned row，由数据库 trigger 以 `42501` 失败关闭；员工 profile 替换也显式跳过这些行。

读取必须合并 canonical group 全部 active 地址并标注 `store` / `portal` 来源。总数最多十条，整个组最多
一个默认地址。future merge 在原 0051 org advisory lock 和确定性 customer lock 内复核这两个边界；
A 合并到 B 后，A 的门店来源地址仍可见。门户写入先取得相同 org advisory lock，再按 UUID 顺序锁
canonical customers、偏好和地址，避免与 merge、隐私擦除或并发更新形成反向锁序。

### 通知偏好 CAS 与隐私证据

新增 `customer_portal_preferences`，以 org + canonical root 保存独立正整数版本和
`none/phone/sms/wechat`。首次门户写入前版本为 0，显示值可回落到 canonical group 最新的 0051
员工 profile 偏好；门户保存后不修改 `customer_profiles` 的姓名、电话、service note、折扣或豁免。
合并组中取最高 portal version，下一次成功写入 canonical root 的 version + 1。

definer 在同一事务重新验证 session hash、authority hash、feature、org/store/customer GUC、canonical
root、数据库时间、地址总数和单默认约束，再替换门户集合并追加 access evidence。profile update 日志只记
`address_count`、`preference`、`profile_version` 以及 Item 10 已有 subject/session/time 字段；不记录地址、
收件人、联系电话、手机号、provider payload 或消息正文。日志保持 append-only。

### Web 生命周期

登录或 resume 成功后，Web 并行读取订单、钱包、权益和 profile。所有请求携带 `AbortSignal`，且只有当前
session generation、当前 operation 的响应可以写状态。logout、过期、重新登录/切换 subject 和组件
dispose 都先换代、取消请求并同步清空 wallet、benefits、addresses、preference 及 Item 10 的订单 PII；
即使旧 fetch 忽略取消，迟到响应也不能复活上一顾客资料。

UI 对门店地址只读，仅把 `source=portal` 集合提交给 mutation；可用容量按十条总上限扣除门店地址。
页面显示钱包/权益状态，但没有充值、支付、兑换、使用或核销按钮。通知偏好旁明确说明保存不等于发送。

## 门禁影响

必须覆盖 Contracts 62/51 freeze、strict schema 与 OpenAPI；`0062` fresh apply/replay、ACL/RLS、direct
DML guard、session/canonical isolation、A→B 地址保留、CAS/单默认/十条边界和 PII-free evidence；Server
参数化 SQL、HTTP auth/CSRF/rate/no-store；Web mobile/desktop、generation/Abort 与 logout/expiry 清空。
生产 JS/TS 文件不超过 400 physical lines，测试文件不超过 800。

## 否决方案

- **否决新增 portal wallet/benefit tables**：0032/0050 仍是唯一资金和权益 authority。
- **否决开放既有 staff profile command**：它能修改顾客不应自助修改的敏感与运营字段。
- **否决 body 携带 customer_id**：subject 只能来自本次已验证 session。
- **否决全量替换 canonical 地址**：会静默删除合并来源或门店维护的有效地址。
- **否决“保存偏好即已通知”**：没有 provider receipt 就不能声称发送或送达。

## 后续

微信小程序身份、真实短信/微信 provider、顾客在线充值/支付、权益消费与配送下单仍须各自 ADR、外部
authority、限额、幂等和真实 provider/支付证据。本实现候选不等于已部署到 hk-vps 或正式生产会员中心。
