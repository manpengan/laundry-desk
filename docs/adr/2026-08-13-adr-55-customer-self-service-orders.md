# ADR-55：顾客自助订单、票据与件级洗护进度

- 日期：2026-08-13
- 状态：Proposed
- 决策者：manpengan
- 实现负责人：Codex
- 影响：Contracts、`0061`、Server customer portal、responsive Web、Cloud 验收

## 背景与范围

Stage 4.4 Item 10 要让顾客在公网 Web 自助查询自己的正式订单、票据与每件衣物的权威洗护
进度。现有员工 access token、staff 权限与内部查询会暴露过多能力，不能直接复用；但订单、支付、
衣物和状态流水已经是权威数据，也不能为门户复制第二套订单或票据账本。

本 ADR 只关闭只读自助面。不含 Item 11 的钱包、积分、次卡、券包、地址与通知偏好，不创建
微信小程序，不发送通知，也不把内部备注、员工、架位、条码、异常原因或照片暴露给顾客。

## 决策

### 独立顾客会话

新增 `/customer` Web 入口与三个专用 auth 路由。登录只接受组织代码、门店代码、手机号和已有
取件码。PostgreSQL definer 在 feature 已显式开启的门店内校验手机号与同 canonical customer group
的正式订单。登录请求开始前，每个浏览器 tab 另生成随机 256-bit authority 原文并只存于该 tab 的
`sessionStorage`；页面还用仅存在内存的随机 tab instance nonce 通过同源 Web Locks 独占该 authority
的 SHA-256 selector。由 opener 或 duplicate 复制出的 tab 不能取得同一租约，必须失败关闭并重新登录；
reload 在旧页面释放租约后可恢复。成功后服务端同时签发随机 256-bit session/CSRF secret，数据库只保存
三者 SHA-256。
会话最长 15 分钟，每个 canonical group 在整个组织最多五个 active session；canonical merge 与
登录共用同一 advisory-lock 边界，并在 merge 事务内立即收敛组合后的旧会话。`laundry_app` 不具备
`merged_into_id/merged_at` 列更新权，merge 只能调用先取 advisory lock、后锁 customer row 的
owner-definer 原语。登出或过期即失效。

失败一律返回相同 `AUTHENTICATION_FAILED`，不说明手机号、取件码、组织或门店哪一项不存在。
登录按账户维度和真实来源限流；session/logout/query 另按 session/source 限流。公网 Caddy 必须用
`header_up X-Laundry-Proxy-Client-Ip {remote_host}` 覆盖客户端同名输入。release preflight 用同一
fail-closed parser 绑定 `desk.manpengan.xyz` 在 `:443` 的唯一实际 handler，要求 `/health`、`/api/*`、
`/v1/*` 只进入唯一 `127.0.0.1:8787` upstream，同时 exact 覆盖 `Host`、删除 `Forwarded`、
`X-Forwarded-*`、`X-Real-IP`；安全 decoy 不能掩盖真实 route 的缺口。Fastify 保持
`trustProxy=false`，仅 loopback peer 可提交该专用来源，公网 profile 缺失/多值/非 IP 即失败关闭；
`Forwarded`、`X-Forwarded-*`、`X-Real-IP` 仍一律拒绝。故同一 socket 轮换手机号仍进入同一来源桶，随机
号码不能扩张账号桶绕过 credential-spray 上限。logout 不经过共享 read/query 桶：一旦 session、authority
和 CSRF 证明有效，必须先完成服务端 revoke，再清 selector Cookie。认证成功、不存在顾客或错误取件码统一等待到相同 500ms
下界，避免显著的存在性时序差。所有 POST 使用 same-site Origin/Fetch Metadata 与 double-submit CSRF。

login、resume、logout 与五条 query 都必须携带 `x-customer-portal-authority`。每次 login generation
用 authority 的 SHA-256 base64url 投影派生独立 session/CSRF cookie 名，Cookie 元数据不包含原始
authority；服务端用被选 Cookie 定位 session row 后，对 header 原文 SHA-256 与行内 authority hash 做常量时间比较；缺失、格式错误或不匹配
均失败关闭。这样迟到 A login 的 Set-Cookie、A logout/resume 的 Clear-Cookie 只影响 A selector，不能覆盖或
清除 B 的 Cookie；同 tab 的当前 authority 是串行 cookie selector。authority mismatch 也只清当前 selector，
不能清另一合法 tab。reload 可从同一 tab 的 `sessionStorage` resume 并重新取得独占租约；新 tab没有
authority，复制 tab 也不能共享已有租约，二者都必须重新登录。
logout 发请求前捕获旧 authority 并立即从本地移除，再用捕获值完成吊销。应用日志把 authority 和可信来源
header 作为凭据/PII 字段强制脱敏，access log 也不记录其原文或哈希。

Web 状态仍以单调 session generation 做纵深防御。resume/login/logout 会先换代、取消既有请求并清空
订单、选择、票据/衣件明细和进度；每个 list/select/progress 请求都携带 `AbortSignal`，响应写入前还必须
匹配当前代际与当前 operation。即使旧网络实现忽略取消，服务端 tab authority 绑定也阻止错误 Cookie
返回另一顾客 PII，前端 generation 再阻止已取得的旧响应复活。
login/resume 成功后还按服务端 `expires_at` 安排 timer；到期立即换代、取消所有请求、清空订单/明细/进度、
移除 authority 并把 authenticated 置为 false，不能靠仍打开的页面延长服务端会话。

### 数据归属与 canonical merge

会话保存登录时 canonical root，且每次 resolve 和事务内 query 前都重新解析 canonical root。查询的
订单范围是当前组织、当前登录门店、`customer_canonical_group(root)` 内所有 source customer 的正式
订单；因此合并前 source 订单在合并后仍可见。跨组织、跨门店、跨顾客或不存在的 UUID 统一返回
`RESOURCE_UNAVAILABLE`，不能用于枚举。

匿名化、PII purge、会话吊销或 feature 关闭会使既有会话/查询立即失败。门户不会用订单冗余手机号
作为身份 authority，也不会让客户端提交 customer、org、store 或 tenant GUC。

### 权威只读投影

新增五条 query：

- `customer.self_service.orders.list`（最多 20 单）；
- `customer.self_service.order.get`（一单与最多 200 行）；
- `customer.self_service.receipt.get`（一单、行项目与最多 200 笔支付流水）；
- `customer.self_service.garments.list`（最多 200 件）；
- `customer.self_service.garment.progress`（一件与最多 200 个状态节点）。

查询全部 R2/PII、online-only、排除 AI。输入 Zod strict；输出再次用 strict schema 解析，意外多出的
内部字段会使整个响应失败，而不是被静默透传。金额只接受整数分；支付方式直接复用生产账本的
`cash/wechat/alipay/other/balance` 五值 schema。件级当前状态直接读取 `garments`，
节点只读取 `garment_status_log` 的 `from_status`、`to_status` 和时间；不合成“预计完成”或伪造实时节点。

PostgreSQL `security_barrier` / `security_invoker` views 只投影所需列，且重复施加 feature、tenant、
canonical group 和 PII lifecycle 条件。门户不读取 `orders.note`、`payments.note`、`garment_incidents`、
staff、barcode/rack、打印 snapshot 或照片。

### feature 与证据

`store_features.customer_portal` expand-only 加列，默认 `false`。没有显式开启就没有登录权威，符合
hard-off 默认。新增 `customer_portal_sessions` 和 append-only `customer_portal_access_log`；日志只含
org/store/customer/session、操作、可选资源 UUID 和时间，不含手机号、姓名、取件码、IP、User-Agent、
内部结果或员工信息。业务数据仍是现有 authority，不产生门户订单/票据副本。

## 契约与门禁影响

freeze 从 **62/43 → 62/48**。五条 PII query 与 login/session/logout 完整 HTTP 面必须留在正式
契约/OpenAPI（含严格空 logout body、动态 selector cookie、CSRF、tab authority、各状态 no-store、
实际 Set/Clear-Cookie 副作用，以及 login/session 的 429/Retry-After），但明确不进入
`M2_READ_ONLY_AI_DEFINITIONS`。`0061_customer_self_service.sql` 必须通过 fresh apply/replay、RLS/ACL、
canonical merge、跨顾客/租户/门店和匿名化真库验证。Web 必须覆盖 mobile/desktop、CSRF、会话吊销、
限流、猜 ID 同响应、strict output 与敏感字段缺席。

## 否决方案

- **否决复用 staff 登录/查询**：权限、生命周期和返回字段都不适合公网顾客。
- **否决手机号单因素登录**：可枚举且缺少已有订单的 possession proof。
- **否决客户端带 customer/org/store**：会把会话租户边界交给不可信输入。
- **否决复制门户订单/票据表**：会形成漂移的第二权威账本并扩大 PII 保留面。
- **否决由 UI 推断洗护时间线**：只能展示已有状态与 immutable log，不能伪造实时节点。

## 后续

Item 11 可复用同一顾客会话，但钱包、次卡、积分、券包、地址与偏好必须独立冻结读写权限、资金/
权益 authority 和确认语义。若改为微信小程序登录，需要另立平台身份绑定与 provider 外部证据。
