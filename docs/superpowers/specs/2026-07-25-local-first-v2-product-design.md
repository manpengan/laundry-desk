# laundry-desk 通用 V2 本地优先产品设计

> 日期：2026-07-25
> 状态：**Approved**
> Owner：Codex
> 决策记录：[ADR-14](../../adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md)

## 1. 设计基线

本设计不是新建第三套架构，而是对 Claude 2026-07-19 定稿框架的首期交付裁剪：

- 系统架构：`2026-07-19-laundry-v2-architecture.md` draft3.1a；
- UI/交互：`2026-07-19-laundry-v2-web-ui-design.md` draft3.1a；
- 视觉工程：`2026-07-18-liquid-glass-ui-2.md`；
- 当前实现基线：`main@c4146ea`。

继续保留多租户、RLS、Command/Query Bus、件级衣物、只追加支付流水、Liquid
Glass 与 Electron 安全边界；只调整产品对象与实施顺序。

## 2. 目标与非目标

### 2.1 首期目标

交付一套可在本机完成真实业务测试的通用 V2：

1. Fastify 与 PostgreSQL 作为独立 localhost 服务运行；
2. 浏览器与 macOS App 使用同一 React SPA、同一 contracts 和同一 API；
3. 完成“登录 → 开单 → 收款/欠款 → 模拟打印 → 部分/整单取衣 → 补款 →
   统计 → 交班”的完整工作日；
4. 所有验收业务数据进入真实 PostgreSQL，并经过 RLS、事务、审计和幂等链；
5. UI 以 Claude draft3.1a 的柜台布局与 Liquid Glass 为准。

### 2.2 明确不做

首期不做：

- 宏发专版、宏发品牌包装或 v1 数据迁移；
- 云部署、跨设备同步、离线交易队列、offline grant、Primary lease；
- AI/BYOK、会员、短信/微信、照片、工厂协同、取送与营销；
- 真实小票/水洗唛/不干胶硬件；
- Windows 打包与实机适配；
- macOS 公证、正式发布和自动更新。

这些能力继续沿用 draft3.1a 的接口与安全方向，后续逐期解闸。

## 3. 运行架构

```text
浏览器 http://127.0.0.1:5173 ─┐
                               ├─ 同一 React SPA / contracts / UI
macOS App app://local ─────────┘
              │
              │ HTTP（桌面经受限 IPC transport）
              ▼
Fastify http://127.0.0.1:8787
  Zod → Auth/RBAC → tenant → policy → invariant
       → transaction（业务 + audit）→ event
              │
              ▼
PostgreSQL 16 127.0.0.1:8543
  laundry_app / FORCE RLS / per-transaction GUC
```

### 3.1 进程边界

- Fastify、PostgreSQL 与 macOS App 分别启动；Electron 不内嵌或拉起数据库/服务。
- App 启动先做 `/health` 检查。服务不可达时显示明确的本地服务诊断页与重试按钮，
  不进入假在线工作台。
- 浏览器开发地址固定为 `127.0.0.1`，不混用 `localhost`，避免 cookie、Origin
  和测试基线漂移。
- Compose 端口只绑定 loopback；PG 与 API 不发布到 LAN。
- Fastify 在宿主机运行时固定监听 `127.0.0.1`；Compose 容器内可监听
  `0.0.0.0`，但端口只能发布到宿主 `127.0.0.1`。两种模式都使用
  `trustProxy:false`，只接受配置中的精确 `Host` authority，并拒绝 forwarded
  host/proto。loopback 来源不豁免认证或授权。
- 未认证 `/health` 只返回最小存活状态；其他本地辅助接口全部鉴权。
- `memory` runtime 仅用于单元测试。手工验收、Playwright 与 macOS smoke 均必须
  使用 `local-pg`。

### 3.2 本地产品身份

- 活动代码不再特殊识别 `hongfa`。
- 固定首期 bootstrap 标识为通用 local org/store/admin；值从集中配置读取，
  前后端不各自硬编码，凭据不固定。
- demo seed 只能由显式 CLI 执行，并同时要求 local build、loopback 数据库、
  `LAUNDRY_LOCAL_DEMO=1` 与确认参数；不提供 HTTP seed/reset 接口。
- demo 与非 demo 的管理员密码/PIN 都由外部环境提供；源码、日志、构建产物不得
  包含默认凭据。demo 数据写入 `demo_only` 标记，非 demo/云启动发现该标记即拒绝。
- 非 demo 空库通过一次性 bootstrap CLI 幂等创建 org/store/admin。CLI 同时生成
  高熵签名 secret，写入仓库外的本地配置目录（目录 `0700`、文件 `0600`）；
  缺少必填输入或已有非匹配 bootstrap 时快速失败。
- 登录后的门店名称来自服务端 session display，不由客户端根据代码映射。
- 产品名统一为 `laundry-desk V2` 的通用名称；旧 `Hongfa Laundry` 打包配置退出
  V2 构建。

### 3.3 本地服务生命周期

- 首期规范验收环境依赖 Docker Desktop（或兼容 Compose runtime）。
- `pnpm local:up` 依次启动 PG、执行 expand-only migrations、检查 schema、执行已
  明确请求的 bootstrap，再启动 Fastify；任一步失败则 API 不进入 ready。
- `pnpm local:down` 只停进程并保留命名 volume；macOS App 不安装、启动、停止或
  删除 Compose 服务。
- 本地开发可只用 Compose 起 PG、在宿主机运行 Fastify，但该模式不是验收真源。
- 首期不宣称应用内自动备份/恢复；测试 volume 持久保留，重置必须使用独立的显式
  destructive 命令与二次确认。正式备份/恢复在后续产品切片交付。

## 4. 共享 Web 与 macOS App

### 4.1 单一 SPA

- `apps/web` 产出可部署静态 bundle。
- 浏览器 host 与 Electron host 只负责注入 transport/config，不复制页面、状态或
  业务规则。
- 构建任务把同一 bundle 写入 Edge 资源目录并生成覆盖**全部 SPA 文件**的
  path/hash/MIME manifest；`app://` 只按 manifest key 加载已逐项校验的资产。
- 当前 `apps/edge-agent/resources/spa` 占位页删除出活动构建链。

### 4.2 桌面 API transport

`app://` 与 `http://127.0.0.1` 的 cookie/CSRF site 不同。首期不放宽为
`Access-Control-Allow-Origin: *`，也不允许 `null` Origin。

Electron 使用受限、无 token 的 IPC transport：

- preload 只暴露 `auth`、`command`、`query` 与 `health` 四类操作；
- 每个操作使用独立 Zod schema；命令/查询名必须来自 contracts 注册表；
- main 进程固定 API base 和路径模板，拒绝任意 URL、任意 method、任意 header；
- main-only `DesktopAuthState` 持有短效 access token、refresh/CSRF cookie 和
  session version；renderer 只得到不含 token 的 `SessionView`；
- refresh cookie 与 CSRF cookie 留在独立 Electron session；renderer 不接触
  access/refresh token、cookie 或请求头；
- 每次 IPC 同时校验目标 `webContents`、`senderFrame === mainFrame` 与规范化后的
  精确 `app://local/...` URL；
- 返回值保持统一信封，网络错误映射为用户可行动的错误，不吞异常。

main 进程创建专用 `session.fromPartition("persist:laundry-v2-local")`，并使用
Electron `net.request` 的 `session`、`credentials:"include"`、`redirect:"error"`
与固定 `origin:"app://local"` 发起 API 请求，使 refresh/CSRF cookie 只进入该
session。Origin、method、URL 与 header 均由 main 构造，不接受 renderer 覆盖：

1. login：session fetch 接收并保存 Set-Cookie，access token 写入
   `DesktopAuthState`，只返回 `SessionView`；
2. refresh：main 从同一 cookie jar 读取 CSRF 值，发送 refresh cookie +
   `X-CSRF-Token`，原子替换 access token/session view；
3. command/query：main 按冻结 contracts 附加 Bearer 与所需 CSRF，renderer 只传
   已验证的业务 input 和 idempotency key；
4. PIN 快切/角色变化：服务端轮换 session，main 原子替换 auth state；
5. logout：先撤销服务端 session，再清空 main auth state 与专用 session cookie。

所有 Electron cookie-auth 请求固定发送 `Origin: app://local`；服务端独立于 CORS
精确校验，并拒绝缺失、`null` 或其他 Origin。

浏览器继续使用直接 HTTP transport，并把 token 保存在 client closure 内存。
React App 只消费 `SessionView` 与已完成鉴权的 `AuthPort`、`CommandPort`、
`QueryPort`，不读取 token；两个 host 因此共享页面和业务状态而不共享凭据实现。

浏览器业务 API 只接受短效 Bearer access token，不得回退为 cookie-only 鉴权；
refresh/logout 使用 refresh cookie。命令类 POST 继续按冻结 contracts 同时校验
CSRF。所有 cookie 鉴权的状态变更必须校验精确 Origin、会话绑定且轮换的 CSRF
token 与 `X-CSRF-Token`。若 custom scheme 的 SameSite 行为不兼容，不得通过
允许 `null` Origin、`SameSite=None` 或关闭 CSRF 解决。

### 4.3 Electron 安全与 macOS 测试包

继续强制：

- `nodeIntegration:false`；
- `contextIsolation:true`；
- `sandbox:true`；
- `webSecurity:true`；
- 默认拒绝权限请求；
- 禁任意导航、新窗口与外链；
- CSP 至少为
  `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'none'`，
  禁 `unsafe-inline` / `unsafe-eval`；
- `app://` handler 拒绝目录遍历、软链接、未知 MIME 与 manifest 外资产，hash
  不匹配时 fail closed；
- renderer 不获得通用 fetch、URL、method、header、cookie 或 shell 能力。

首期生成可重复构建的 macOS `.app` 本地测试产物，并记录 hash。签名、公证、
DMG、自动更新和分发不是首期门禁；未签名测试包的 hash 只证明构建一致性，
不宣称发布级防篡改。

Local Foundation 仅在核对 lockfile 后显式允许已锁定版本的 Electron 安装脚本；
不得使用动态/latest 下载，也不得顺带放开无关依赖的构建脚本。

## 5. 柜台工作日

### 5.1 页面范围

首期导航只开放：

- 工作台；
- 开单；
- 取衣；
- 顾客；
- 订单与欠款；
- 今日统计与交班；
- 设置中的价目、字典和模拟打印。

未交付模块通过 feature flag 隐藏，不展示无功能的入口。

### 5.2 登录与员工归属

- 管理员以组织码、门店码、用户名和密码登录。
- 员工以 PIN 快切；每笔命令使用当前 session 的真实 `staff_id`。
- HTTP 入口必须接入严格 session resolver：校验 token 过期、claims/session 一致性、
  session version、staff/store role 与租户范围。
- 首期 access token 固定 `HS256`/`typ=AT`，secret 至少 32 随机字节，issuer
  `laundry-desk-v2-local`、audience `laundry-desk-v2-api`，严格校验 header、
  issuer、audience、`iat/exp` 与 15 分钟 TTL；refresh token 使用高熵随机值，
  服务端只存 hash，单次轮换并检测复用。登录、PIN 快切、角色变化和 logout 都
  必须废止旧会话；认证响应使用 `Cache-Control: no-store`。
- 本地 HTTP refresh/CSRF cookie 都必须 host-only、无 `Domain`、
  `SameSite=Strict` 且有限时效；refresh cookie 为 `HttpOnly`，冻结的双提交
  CSRF cookie 按 contracts 保持 `HttpOnly=false`、值为会话绑定的随机 proof。
  `Secure=false` 只允许已确认绑定 loopback 的 local profile，且不使用要求
  `Secure` 的 `__Host-` 前缀。
- `/api/v2/local/staff` 等本地辅助接口不得匿名访问。
- 登录至少按 org/store/username 与 IP 双维度限速；PIN 按 session/store/staff
  与持久化 lockout 限制，不能只依赖所有请求共有的 `127.0.0.1`。失败响应不得
  泄露账号是否存在，并产生脱敏审计事件。

### 5.3 工作台

按 Claude 三栏结构落地首期子集：

- 左：自动聚焦的取件码/票号/条码查找；
- 中：今日收衣、取衣、实收、欠款指标与今日订单；
- 右：顾客速查和“开单/取衣”快捷动作；
- 顶栏：门店、员工、本地服务状态、模拟打印队列。

首期只有单机在线模式，状态条显示“本地服务正常/不可达”，不伪造离线同步数量。

### 5.4 开单

沿用 Claude 三栏与键盘流：

1. 查找或快速创建顾客；
2. F1–F11 选择服务，助记码/宫格选择品类；
3. 数量只用于生成 N 件 garment，每件仍独立记录；
4. 中栏可编辑件级颜色、品牌、瑕疵、附件与备注；
5. 右栏实时显示原价、折扣、附加、加急、运费、应收、已收和欠款；
6. 选择付款方式后结算，或暂存挂单。

首期价格规则冻结为：

```text
original = Σ(effective_unit_price × qty)
payable  = original - discount + addon + urgent + freight
balance  = payable - Σ(payment ledger)
```

- 服务端按 catalog id/code 读取当前价格并冻结 `catalog_unit_price_cents`；
- 普通客户端不能提交任意单价；人工单价覆盖另存
  `override_unit_price_cents + reason + actor`，经独立权限和 R4 step-up 后成为
  `effective_unit_price`；
- 首期手工折扣只支持订单级固定整数分，不做百分比/会员折扣；折扣仅作用于
  original，且 `0 ≤ discount ≤ original`；
- addon 是服务端价目中的件级附加项之和；urgent 与 freight 是门店配置解析出的
  订单级固定整数分，未配置即 0；
- 五段可叠加，计算顺序固定如上；整数分无舍入，所有乘加必须保持 safe integer，
  已收不得超过 payable。

客户端可预览同一 domain 纯函数，但 server 结果是唯一权威。

### 5.5 支付、欠款、挂单与撤销

- 首期 order 状态为 `draft | open | closed | cancelled`：
  - `order.hold` 接收完整草稿，创建/更新 draft 并返回 `draft_id`；保存客户、行与
    价格快照，不生成 garment、ticket、payment 或营业统计；
  - `order.receive` 接收完整订单输入及可选 `draft_id`；无 draft 时原子创建并
    open，有 draft 时锁定并转 open，同时生成 ticket、garments 和首笔 payment；
  - draft 可显式丢弃并保留审计；不能直接取衣；
  - open 在全部 garments 终态且余额为 0 时转 closed；
  - open 仅在无已取 garments 时可 cancel；closed/cancelled 首期不 reopen。
- 首付输入为可选 `{ amount_cents, method }`，method 只允许
  `cash|wechat|alipay|other`；省略或金额为 0 时不写 payment row，正数时必须
  同事务追加一条 ledger。
- `order.receive` 在同一事务写订单、订单行、garments、首笔 payment ledger 与
  audit，任何一步失败整体回滚。
- payment ledger 只追加；退款、更正和撤单使用引用原流水的 reversal。
- `order.hold` 保存可召回草稿，不进入营业收入。
- `order.cancel` 必填原因，并原子回冲已有收款；已取衣物的订单不能普通撤销。
- `payment.collect` / `payment.repay` 支持独立补缴，使“衣物已全部取走但仍欠款”
  的订单最终可关闭。
- 订单聚合金额必须可由价格快照与 payment ledger 复算；不允许仅更新汇总列。

### 5.6 取衣

- 查找支持票号、取件码、衣物条码、手机号和姓名；不要求用户输入内部 UUID。
- 件级勾选使部分取衣成为一等流程。
- 取衣可与补收欠款在同一事务完成。
- PG 读取与状态变更使用行锁或带 `version` 的 CAS；并发双击/双终端只能成功一次。
- 全部衣物进入终态且余额为零后，订单才关闭。

### 5.7 营业日、统计与交班

- 营业日由门店 IANA timezone 与切日时刻决定；所有 server 查询统一调用 domain
  `businessDayAt`，禁止客户端或 SQL 默认 UTC 日历。
- 首期冻结设置键 `business_day.cutover_local_time`，格式 `HH:mm`，默认 `00:00`；
  timezone 继续来自 store 的 IANA 值。
- 今日实收来自 payment ledger，不读取不可信的订单汇总。
- 每店每营业日最多一次正式关闭。期间从上次关闭时刻（首次为本营业日切点）到
  当前关闭时刻；期初现金取上次保留备用金，首次为 0。
- `shift.close` 输入固定为营业日、实点现金、保留备用金、备注和签名；服务端冻结
  各付款方式收款/还款/退款/红冲、应有现金、实点现金、差额、期初/期末时刻的
  不可变快照。重复关闭由唯一约束拒绝。
- 关闭后，映射到同一营业日的业务写入一律返回 `SHIFT_CLOSED`；首期不提供 reopen
  或回改快照，错账只能通过后续显式 reversal 留痕，不能静默改已关账数据。
- 交班提交走命令总线、确认/step-up、事务与审计。

## 6. 数据与一致性

### 6.1 首期活动模型

首期使用并补齐：

- identity：orgs、stores、staffs、staff_store_roles、sessions、pin_lockouts；
- customer：customers；
- catalog：service_types、item_catalog 与必要字典；
- order：orders（含 draft）、order_lines、garments、状态日志；
- payment：payments append-only ledger；
- printing：print_jobs；
- accounting：shift_closings（含固定 schema 的汇总快照）；
- platform：audit_log、command_idempotency、command_pending_actions、
  step_up_proofs。

所有门店表继续使用 `(org_id, store_id, ...)` 组合约束与 FORCE RLS。

`command_pending_actions` / `step_up_proofs` 持久化 canonical args/hash、tenant、
发起人、复核人、idempotency key、过期时间和状态。复核人不得与发起人相同；
执行时在业务事务内 CAS 单次消费 proof，服务重启不能丢失或重复授权。

### 6.2 幂等与并发

- 冻结 A2 command wire payload 中的 `idempotency_key` 是唯一真源；不新增竞争的
  HTTP header 语义。HTTP route 验证并原样传入总线。
- `command_idempotency` 保存 tenant、command、key、canonical request hash、
  `in_progress|completed` 状态与规范化结果，唯一键为
  `(org_id, store_id, command, idempotency_key)`。
- 首次执行在业务事务中以唯一键原子 claim，同一事务完成业务写、audit 与结果
  持久化；进程在 commit 后、HTTP 返回前崩溃时，重试仍读取同一结果。
- 并发相同 key 只能执行一次；同 key 不同 request hash 返回冲突，不能复用旧结果。
- 订单、支付、取衣和撤单的多表写入使用一个租户事务。
- audit 写入失败时业务回滚。

### 6.3 本地安全配置

- access-token signing secret、数据库密码和 seed 密码不得有源码默认值；
- 本地启动脚本生成或要求显式环境值，并在缺失时快速失败；
- Compose 的 PG/API 端口绑定 `127.0.0.1`；
- CORS 只允许精确配置的浏览器 Origin，不反射、不使用通配符/正则放宽、不接受
  `null` 或未知凭据来源；状态变更只接受 JSON 与 contracts 规定的自定义头；
- Fastify 启用结构化请求日志、认证限速和全局错误映射；
- 请求/响应日志删除或脱敏 `Authorization`、`Cookie`、`Set-Cookie`、
  `X-CSRF-Token`、密码、PIN、refresh/access token 与认证请求体字段；
- `laundry_app` 不是表 owner，且无 `SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE`；
  迁移角色与 runtime 角色分离。租户 GUC 只由验证后的 session 生成，在同一事务
  `SET LOCAL`；请求 body/header 不得注入租户，SQL 全部参数化；
- 错误信封不返回 SQL、路径、token、完整手机号或 stack。

## 7. 模拟打印

首期在 `apps/server` 定义 local-only `FilePrinterPort` worker：

- server 在业务事务中只创建不可变 `print_job`；
- worker 用 PG `SKIP LOCKED` 原子 claim，读取版本化 payload，渲染 UTF-8 TXT
  artifact 并写入显式配置的 spool 目录；
- claim 持久化 `attempt_count / claimed_at / lease_until / worker_id`；worker
  崩溃后过期 lease 可原子重领，超过最大尝试次数转 failed；
- 文件名只由已验证的 job id、类型和序号组成，禁止用户输入路径；
- spool 根目录规范化且位于 Web 静态根之外；目录 `0700`、文件 `0600`，拒绝
  软链接。artifact 最终路径由 job id 唯一决定：先写临时文件并 fsync，再以
  no-replace 原子安装；已存在时必须 hash 相同才复用，否则 fail closed；
- 限制单任务 payload/输出大小、总配额、并发与保留期；worker 不调用 shell，
  不执行用户模板；
- 成功记录 artifact hash/大小/完成时间；失败记录安全错误码并允许重试；
- UI 常驻显示 queued/printing/done/failed，并可重试或补打；
- 浏览器与 macOS App 观察同一 PG 队列。预览/下载按鉴权后的 artifact id 定位，
  不接受路径，并返回 `nosniff`、`no-store`。

未来真实硬件仍由 Local Edge Agent 执行：server 通过冻结的 dispatch/receipt
协议交付任务并接收终态回执，不把云端 server 改成 USB/串口驱动。业务命令和 UI
状态不变，但执行拓扑不是简单替换 server 同进程 adapter。

## 8. UI 与代码质量

### 8.1 Claude 设计约束

- 导航 64px，可展开 208px；顶栏常驻连接与打印状态；
- 柜台屏 ≥1280 使用 12 列三栏；1024–1280 右栏抽屉化；
- 主目标高度 ≥44px；金额和票号使用 `MoneyText` 等宽数字；
- 状态必须色+形双编码；
- 列表行不使用逐行 blur；同屏 `backdrop-filter` 不超过 8 层；
- 深浅色与 `prefers-reduced-motion` 都必须通过；
- 危险操作统一使用“权限 + 原因 + 影响面复述”组件。

首期优先补齐 `ServiceTabs`、`CategoryGrid`、`GarmentRow`、
`CustomerSummaryCard`、`DangerConfirm`、`ReceiptPreview` 和工作台布局。

### 8.2 结构整理

- 当前超长 `shell.css` 按 shell、workbench、receive、pickup、customer、stats
  拆分，每个文件保持聚焦；
- 页面业务状态、纯函数与视图组件分离；
- 文件目标 200–400 行，硬上限 800；函数小于 50 行；
- 禁 `any`、静默 catch、硬编码色值/阴影/圆角和浮点金额；
- 状态更新使用不可变模式。

## 9. 验收门禁

### 9.1 自动化

1. contracts/domain 单元测试：计价、折扣、挂单、撤单、支付红冲、部分取衣、营业日；
2. server 真实 PG 集成：
   - 收衣与首付同事务；
   - 并发同幂等 key 只执行一次、同 key 不同 request hash 冲突、commit 后重试
     返回原结果；
   - 并发取衣只能一次成功；
   - 撤单红冲；
   - 独立欠款补缴后关闭；
   - 关账后同营业日写入被拒绝；
   - RLS 跨租户/跨门店负向；
   - runtime 角色无 owner/BYPASSRLS 等高权，连接池复用不残留 GUC；
   - step-up proof 跨重启保留、禁止自核且只能消费一次；
   - audit 与业务同事务；
3. Playwright 真实 PG 完整工作日：
   - 登录/PIN；
   - 建客户；
   - 开一张部分付款订单；
   - 验证 mock spool；
   - 部分取衣；
   - 余件取衣并补缴欠款；
   - 验证日统计与交班；
4. Electron/macOS smoke：
   - 任一 SPA asset 篡改都使 `app://` 完整性校验 fail closed；
   - 本地服务不可达提示；
   - 登录并执行同一套核心页面；
   - renderer 不可见 token/cookie/header，preload/API bridge 无通用 fetch 与越权
     路径；
   - Electron main 的 cookie-auth 请求固定 Origin，缺失/`null`/伪造 Origin 被拒；
   - 子 frame、错误 sender、manifest 外路径和软链接均被拒绝；
5. local security：
   - Host/Origin/Fetch Metadata/CSRF、DNS rebinding 与 tenant spoof 负向用例；
   - demo bootstrap 条件、默认凭据和非 demo `demo_only` 拒绝；
   - spool 路径、权限、软链接、配额、并发 claim 与 artifact RBAC；
   - worker claim 后被终止时 lease 可恢复，且最多产生一个终态 artifact；
6. lint、format、strict typecheck、build 全绿。

### 9.2 人工走查

- 浏览器与 macOS App 在相同数据上显示一致；
- 1280px 柜台流全键盘可达，目标熟手开单不超过 15 秒；
- 深色/浅色、减弱动效和服务断开/恢复均有诚实反馈；
- 模拟打印文件可定位、可预览、失败可重试；
- 所有用户可见名称与数据均为通用产品，不残留宏发专用包装。

## 10. 实施切片

按依赖顺序推进：

1. **Local Foundation**：通用 bootstrap、loopback compose、严格 auth、共享 CSS、
   Web bundle → `app://`、受限桌面 transport、macOS 本地构建；
2. **Money Integrity**：权威计价、首付 ledger、PG 幂等、取衣并发控制；
3. **Workday Commands**：hold/cancel、collect/repay、营业日、统计/交班一致性；
4. **Counter UI**：Claude 三栏工作台、三栏开单、统一查找取衣、危险操作组件；
5. **Mock Print**：PG print job + 文件 spool + UI 状态；
6. **Acceptance**：真实 PG 完整工作日 E2E 与 macOS App smoke。

每个切片必须先写失败测试，再实现最小代码；未通过本切片门禁，不提前展开云、
Windows、AI 或真实硬件。
