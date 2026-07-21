# A5 会话、refresh、CSRF 与 PIN 契约设计

> 日期：2026-07-21；状态：Approved for implementation（manpengan 已授权 Codex 采用推荐方案并独立完成）；范围：`packages/contracts`，不包含 JWT 签名、密码哈希、数据库、HTTP middleware 或 UI。

## 1. 目标与依据

A5 冻结 C6/C8、A6/A7 和 Grok E1/E3 共同消费的身份线路边界，依据：

- 架构 §3：access 15 分钟、仅内存；refresh 14 天、httpOnly + SameSite cookie 轮换；
  命令类 POST 使用 CSRF 双提交；柜台支持 PIN 快切；
- ADR-02 #10：actor 与 tenant 只能来自服务端认证会话；
- ADR-05 #11：step-up 短时、单次、不可自核；
- ADR-11：login/refresh/logout 使用窄化 lifecycle envelope，普通命令信封接受有来源登记的
  browser/Edge 判别联合；
- 当前治理门禁：refresh reuse、会话撤销/固定攻击、CSRF 跨源、PIN 暴力破解与
  step-up 过期必须有可失败的负向测试。

A5 是契约冻结，不宣称身份服务已经可用。C6/C8 仍必须实现并实测密码学、原子轮换、持久化、
限速、cookie 写入、Origin 校验和服务端认证上下文注入。

## 2. 方案取舍

### 2.1 采用：安全语义契约 + 纯判定

contracts 冻结：

- TTL、cookie/header 名称和安全属性；
- access/session、refresh family/token、CSRF proof、PIN challenge 的严格 schema；
- 不可由同形对象伪造的运行时 provenance；
- safe/unsafe method、refresh 状态迁移、reuse 后果、PIN challenge 可消费性的纯判定；
- session active/version 校验、logout 与 refresh reuse 的级联撤销；
- 浏览器可见数据与服务端状态的显式分离。

C6/C8 注入可信时钟、密码学、数据库事务和 allowlist，不让 contracts 连接外部系统。

### 2.2 未采用：仅做 DTO

DTO 无法冻结 refresh reuse、会话固定攻击、CSRF session 绑定和 PIN 单次消费。各消费方会形成
第二套安全语义，直到集成阶段才暴露分歧。

### 2.3 未采用：在 contracts 实现完整身份运行时

JWT/HMAC/Argon2、cookie I/O 与数据库轮换属于 C6。把这些放入 contracts 会引入平台依赖，破坏
纯契约包，并让前端生成物意外携带服务端能力。

## 3. 组件边界

### 3.1 `auth/session`

- `ACCESS_TOKEN_TTL_SECONDS = 900`；解析后要求 `exp - iat` 精确为 900 秒。
- access claims 绑定 `session_id/session_version/org_id/store_id/staff_id/device_id`、权限版本、
  认证方式、`iat/exp`；不接受客户端自报身份。
- 登录/refresh/PIN 快切的浏览器响应可含 access token，但字段标注为 memory-only；不得提供
  localStorage/sessionStorage/cookie 持久化选项。
- 服务端 session record 显式区分 `active | revoked` 并携带单调 `session_version`。C8 在每次请求
  验签后仍须从服务端状态读取 session，要求 active，且 version、actor、tenant、device 与 claims
  全部一致；状态不可读时 fail-closed。不能因 access JWT 尚未到期而跳过撤销检查。
- 服务端认证 session snapshot 使用私有品牌与运行时 provenance；同形 JSON、spread/clone
  不能成为 C8 的可信 actor/tenant 来源。
- A2 `injectAuthenticatedCommandContext` 必须改为接受有来源登记的判别联合，而不是解析任意同形
  actor/tenant：`browser_session` 消费上述 active/version snapshot 且 `via` 仅 ui/ai/automation；
  `edge_replay` 消费 A4 device-session + grant/lease/queue 已复核 snapshot 且 `via` 固定
  edge_replay。Edge authority 必须把队列信封中的 `grant_id`，以及 primary lease 分支的
  `lease_id/primary_epoch`，与服务端复核结果逐项绑定；仅有
  `allowed_commands/primary_lease_commands` 的结构摘要不构成可信来源。错误的
  provenance/via/authorization 组合一律拒绝。两个 authority 分别只由 C6/C8 与 Edge ingress
  持有，并由 apps/server 架构 lint 禁止其他入口调用。

### 3.2 `auth/refresh`

- `REFRESH_TOKEN_TTL_SECONDS = 1_209_600`（14 天）。
- refresh 秘密只允许 cookie 传输，响应 JSON、日志结构与例子均不得包含 token。
- 固定 cookie：`__Host-laundry_refresh`、`Secure`、`HttpOnly`、`SameSite=Strict`、`Path=/`、
  禁止 Domain，Max-Age 为 14 天。
- token 属于一个 family。每次成功 refresh 必须在一个原子操作内消费旧 token、创建新 token、
  标记 replacement；不得允许两个并发请求都成功。
- 已 rotated token 再次提交为 reuse：整族撤销并拒绝签发。revoked/expired/unknown 统一拒绝，
  线路错误不泄露 token 是否存在。
- 登录和 PIN 快切创建新 session + 新 family；旧 session/family 先撤销，防止固定攻击以及前一
  员工继续刷新。
- family reuse、logout、PIN 快切、管理员撤销或凭据变更均须撤销关联 session 并递增其 version，
  从而使旧 access 在下一次请求立即失效；不能只撤销 refresh token。
- logout 是明确状态迁移：数据库撤销操作本身幂等，原子撤销当前 session 与 family，并以与签发
  相同的 host/path/security 属性把 refresh/CSRF cookie 设为 Max-Age=0。首次成功后因凭据已清除，
  重复 HTTP 请求可以返回统一 401；客户端仍保持本地已登出，不能把“存储幂等”承诺成重复 200。

### 3.3 `auth/csrf`

- 固定 cookie：`__Host-laundry_csrf`、`Secure`、非 HttpOnly、`SameSite=Strict`、`Path=/`、
  禁止 Domain；固定 header：`x-csrf-token`。
- CSRF token 是不透明 proof，由 C6 绑定 session/family 后签发。A5 只验证版本化、安全字符和
  长度，不实现或暴露 MAC 密钥。
- 浏览器的 POST/PUT/PATCH/DELETE 必须同时通过 allowlisted Origin 与 cookie/header 同值；
  refresh、logout 和命令 POST 不能豁免。
- GET/HEAD/OPTIONS 不要求双提交 token，但认证与授权照常执行，且不得产生业务变更。
- 初始 login 尚无 session，可不要求双提交 token，但仍必须通过 Origin/Fetch Metadata 防跨源；
  C6 不得把该豁免扩展到已认证命令。
- 比较与 proof 验证由 C6 使用恒定时间原语完成；contracts 的纯判定只返回结构化原因，禁止
  把 token 写入错误文本。

### 3.4 `auth/pin`

- PIN 是 4–8 位 ASCII 数字 secret；不得 trim、coerce、示例化或进入结果。
- challenge 绑定 `challenge_id/session_id/session_version/org_id/store_id/device_id/purpose/nonce`
  与绝对过期时间。`purpose` 仅为 `quick_switch | step_up`；两种 purpose 使用判别联合而不是可选
  字段拼盘。
- quick-switch challenge 额外绑定 `requester_staff_id/target_staff_id`，两者可相同（重新认证）也可
  不同（换班）。
- step-up challenge 必须显式绑定 `pending_action_ref`、`args_hash`、`entity_versions`、
  `idempotency_key`、`requester_staff_id` 与 `approver_staff_id`，且 requester 与 approver 不得相同。
- challenge 默认 120 秒、最多 5 次失败；第 5 次失败后 challenge 不可再消费。C6 还必须按
  org/store/staff/device 维度实施 15 分钟锁定与速率限制，不能只依赖单 challenge 计数。
- quick switch 成功创建新 session/family，撤销旧 session/family；不会在原 session 上原地改
  `staff_id`。
- step-up 成功只产生 5 分钟有效、单次的 proof，不切换当前操作者。proof 逐字段复制 challenge
  的 pending action、canonical args hash、实体版本、幂等键、请求人和审批人绑定；C5 只能按完整
  绑定原子消费，任一字段变化、过期、已消费或自核均拒绝。

### 3.5 `auth/operations`

- 固定浏览器入口：login、refresh、logout、PIN challenge、PIN verify；为每项冻结 method/path、
  lifecycle 或 authenticated envelope、Origin/CSRF/access/refresh 前置、请求/响应 schema、Set-Cookie
  动作和允许的公共错误码。
- login、refresh、logout 使用 ADR-11 `IdentityLifecycleEnvelope`：无 actor/tenant、无 dry-run、无
  confirm_ref，仅允许服务端 HTTP ingress 创建 provenance。login 不要求 CSRF，refresh/logout 必须
  要求 refresh cookie + CSRF；三者都要求 allowlisted Origin/Fetch Metadata。
- PIN 两个入口要求 active browser session + Origin + CSRF；Edge、AI、automation 与 offline 全拒。
- lifecycle 操作仍经注册表校验、限速、事务、安全事件审计与事件投递，不得直调 identity service。
- 矩阵是 A7 auth OpenAPI 的唯一投影源；server-only record、token hash、authority 与品牌工厂不投影。

## 4. 数据流

### 4.1 登录与 refresh

1. C6 在 allowlisted Origin 下验证登录凭据，建立服务端 session/family。
2. 响应体返回 memory-only access token 与安全 session view；Set-Cookie 写 refresh 与 CSRF。
3. refresh 请求同时携带 httpOnly refresh cookie、可读 CSRF cookie 和同值 header。
4. C8 验 Origin/CSRF；C6 对 refresh token hash 行加锁并原子轮换。
5. 成功返回新 access token并覆盖两个 cookie；reuse 则撤销整族和关联 session、递增 version，
   并返回统一认证失败。

### 4.2 PIN 快切

1. 已认证柜台 session 请求服务端 challenge，challenge 固定目标员工、设备、门店与 purpose。
2. 浏览器只提交 `challenge_id + pin`；身份与租户从服务端 challenge/session 取，不接收自报值。
3. C6 验证过期、次数、锁定和 PIN；失败原子递增，成功原子消费。
4. quick switch 撤销旧 session/family并创建新 session/family；step-up 只签发绑定 proof。

### 4.3 logout 与每请求认证

1. C8 验 JWT 后加载 session record；active/version/actor/tenant/device 任一不符即拒绝。
2. logout lifecycle 请求必须通过 Origin、refresh session 与 CSRF，并原子撤销 session/family、
   递增 version、清两个 cookie。
3. logout 后旧 access 即使 `exp` 未到也在第 1 步失败；数据库重复撤销是 no-op，清 cookie 后的重复
   HTTP 请求可统一返回 401，不产生新 session。

## 5. 错误与泄露控制

- Zod 边界使用 strict object；未知字段、accessor/非 plain 动态输入在纯工厂边界 fail-closed。
- 继续复用 A2 统一信封，但按 ADR-11 新增固定公共错误：`AUTHENTICATION_FAILED` → 401、
  `CSRF_REJECTED` → 403、`RATE_LIMITED` → 429。unknown/revoked/reused refresh 均映射同一个
  `AUTHENTICATION_FAILED` 与固定文案；内部 reason 可审计，线路不得泄露 token 状态。
- 任何错误对象不得包含 password、PIN、refresh token、CSRF token、JWT 或其稳定片段。
- 时间字段使用整数 epoch seconds；C6 使用可信服务端时间，浏览器时间不参与有效性判断。

## 6. 测试与验收

测试先 RED 后 GREEN，至少覆盖：

1. access 15 分钟、refresh 14 天和两种 cookie 的完整安全属性；
2. access/session provenance，spread、JSON 与同形对象均不能变成可信 session；A2 注入拒绝
   任意同形 context，只接受 browser/Edge provenance 联合，并拒绝 provenance/via 错配；
3. refresh 正常轮换、并发旧 token 单胜、rotated reuse 撤销整族和 session、revoked/expired/
   unknown 拒绝；旧 access 在 session version 变化后立即拒绝；
4. unsafe method 缺 cookie/header、不相等、跨源、malformed proof 全拒；safe method 规则稳定；
5. PIN 非 ASCII/长度错误、challenge 过期/已消费/次数耗尽、purpose mismatch 全拒；
6. quick switch 必须换 session/family；step-up proof 不得改变当前 actor，且换参、换实体版本、
   换幂等键、自核、过期与重复消费全部拒绝；
7. logout 撤销 session/family、递增 version、生成精确清 cookie 属性；数据库重复撤销为 no-op，
   但清 cookie 后重复 HTTP 请求允许 401；
8. auth operation matrix 覆盖 login/refresh/logout/PIN 的 envelope、method/path、前置、cookie/header、
   浏览器 schema、固定错误与 HTTP status，并可供 A7 纯投影；
9. secret 不可进入 examples/result/session view，生成对象深冻结且调用方输入不会被修改；
10. contracts 全量 test/typecheck/lint、workspace 门禁、diff-check 与双锁文件检查全绿。

## 7. 后续消费约束

- A6 定义 login/refresh/logout/PIN 命令时复用 A5 schema；secret 输入必须 remove-only redaction，
  不得提供 examples。
- A7 只生成浏览器可见 request/response；服务端 refresh 状态、token hash、品牌工厂不投影。
- C6/C8 必须以数据库事务证明 rotation/reuse、logout、session version、固定攻击和 challenge
  单次消费，而不是以内存 mock 宣称完成。
- Grok E1/E3 只能使用 A7 生成物；access token 留内存，不能自行持久化。

## 8. 实现文件边界

A5 预计新增：

- `packages/contracts/src/auth/session.ts`
- `packages/contracts/src/auth/refresh.ts`
- `packages/contracts/src/auth/csrf.ts`
- `packages/contracts/src/auth/pin.ts`
- `packages/contracts/src/auth/operations.ts`
- 对应 `packages/contracts/test/auth-*.test.ts`

A5 必须同时调整 `packages/contracts/src/envelope/server-envelope.ts`、
`packages/contracts/src/envelope/responses.ts` 及其测试，使 A2 信封注入消费 browser/Edge provenance
联合并冻结 auth 公共错误；否则 provenance 只存在于孤立类型中。修改
`packages/contracts/src/index.ts`、README 和 A5 验收单。所有改变仍限制在 contracts/docs，不在本
PR 写 C6 数据库或 HTTP 运行时。
