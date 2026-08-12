# ADR-40：Cloud Owner 公网经营、完整报表与授权门店管理

- 日期：2026-08-11
- 状态：**Accepted**
- 决策者：manpengan
- 前序：[ADR-24：账目双口径报表](2026-08-07-adr-24-accounting-dual-basis-reports.md)、[ADR-26：局域网只读 Owner Dashboard](2026-08-07-adr-26-lan-owner-dashboard.md)、[ADR-27：Owner 明细与授权门店组合](2026-08-08-adr-27-owner-drilldown-portfolio.md)、[ADR-36：Cloud 测试环境](2026-08-09-adr-36-cloud-test-environment.md)、[ADR-37：Cloud Web 主交付](2026-08-10-adr-37-cloud-web-primary-delivery.md)
- 影响：Owner Web、会话投影、授权门店目录、门店资料、员工治理、契约冻结与 Cloud 验收

## 背景

ADR-26/27 已交付单店四卡、三类脱敏明细和组织内授权门店组合，但页面、文案与信任边界仍是
LAN 只读入口。ADR-36 后 Cloud Web 已具备精确 Host/Origin/Fetch Metadata、Secure host-only
Cookie、CSRF、限流和 loopback Fastify/PostgreSQL 边界；这不等于 Owner 产品能力已经公网化。

ADR-24 已有今日、日期范围、月结、职员和五渠道双口径报表，以及带摘要审计的 R3 CSV 导出。
重复建立 Owner 专用账本口径会让同一营业数据出现两套定义。另一方面，当前 PostgreSQL 会话
显示、刷新校验和员工目录仍硬绑定 `LOCAL_PROFILE`，无法把已经存在的组织内门店授权安全地
作为独立登录上下文。

## 决策

### 1. 公网 Owner 复用 Cloud 同源安全链

`/owner` 成为 Cloud Web 的正式 mobile-first 入口，继续使用同一 Fastify 认证、授权、命令/
查询总线和 PostgreSQL RLS；不开放新的端口、反向代理例外、跨站 Origin、转发头信任或匿名
接口。ADR-26 的 LAN gateway 白名单保持不变，不因公网 Owner 增加写路由。

首期仍以当前门店 `active admin` 代理 owner/manager，不新增可绕过门店角色的组织级
`owner` 超级角色。普通 `staff` 在 UI 与服务端均失败关闭。

### 2. Owner 完整报表复用 ADR-24

Owner IA 增加“今日 / 经营报表 / 门店管理”三个入口。经营报表直接复用：

- `accounting.report.get`：今日、最多 366 日范围、月结、按职员汇总和五种渠道；
- `accounting.report.export`：R3 确认、确定性 UTF-8 CSV、SHA-256 完整性与摘要审计。

实收、业绩、订单现金流、储值现金流和余额核销继续只从不可变账本计算；金额保持整数分。当前
切片不新增客户分层、AI 解读或跨店合并账目查询，授权门店组合继续使用 ADR-27 的同口径卡片。

### 3. 新增授权门店目录，不接受客户端租户

新增 R2 查询 `store.authorized.list`，输入为严格空对象。服务端只从当前会话取得 org/staff，
枚举同组织最多 200 个候选，并逐店切换 PostgreSQL store GUC、重新证明该员工在目标门店仍是
active admin；最多返回按 code 排序的 50 家门店：

- `store_code`、`store_name`、只读 `timezone`、`profile_version`、`updated_at`；
- `is_current`，且返回结果必须恰有一个当前会话门店；
- `returned_store_count` 与 `truncated`。

结果不含组织/门店/员工 UUID、顾客 PII、凭据、内部设置或原始审计 JSON，也不进入只读 AI
工具投影。候选超出 200 直接失败关闭，避免无界组织扫描。

### 4. 门店资料写入只作用于当前会话门店

新增 `store.profile.set`（R5 + `store_manage`）。输入只含服务端上次返回的
`expected_profile_version`、新门店显示名称和原因；不接受 org、store id/code、timezone、feature
flag 或任意设置 key。服务端在当前门店事务中锁行，以单调 `profile_version` 做乐观并发；陈旧版本返回
`IDEMPOTENCY_CONFLICT`，业务变更与 `audit_log` 同事务提交，并由另一位当前门店管理员 PIN
复核。

首期不开放门店创建、删除、代码变更、timezone 变更、跨店员工批量迁移或云租户投产。员工
创建、凭据重置和权限治理直接复用既有 `staff.*` R5 契约与当前门店审计，不另造 Owner 版本。

### 5. 跨店管理必须重新认证

Owner 门店目录可发起“切换”：前端先注销当前会话，只预填目标 `store_code` 与当前
`org_code`，用户重新输入用户名和密码。服务端 PostgreSQL 会话投影、刷新校验和员工目录改为
按认证得到的 org/store/staff 读取门店名称、角色和 feature flags；memory runtime 仍只允许
固定本地 profile。

目标门店没有 active role、不是 admin、员工停用或权限版本漂移时，登录失败且不设置 Cookie。
不提供免密切换，不把目标门店塞进现有命令输入，也不让源门店会话替目标门店写审计。

所有 PostgreSQL access projection（密码登录、refresh、Bearer 解析与 PIN quick switch）均重新
读取当前 org/store/staff 的 active role，并只允许 `admin` 进入非 `LOCAL_PROFILE` 门店；角色
降级会让旧 Bearer 与 refresh 立即失败关闭。R5 复核人的角色也按待确认命令所属 org/store
重新查询，不能回退到首店目录或跨店复核。员工目录属于认证敏感响应，必须使用 `no-store`。

当前进程中的价目、顾客、交班、照片和打印等柜台依赖仍按已投产的 `LOCAL_PROFILE` 在启动时
构造。因此，非该 profile 的 PostgreSQL 会话只开放本 ADR 的显式 Owner 总线白名单：上述三类
经营报表查询、账目查询/导出、`store.*` 和 `staff.*` 治理。照片、打印、Edge 与其他柜台命令/
查询统一返回 `RESOURCE_UNAVAILABLE`；PIN step-up 和员工凭据完成路由按当前会话租户执行，继续
开放给 Owner 治理使用。在所有柜台依赖改为 request-scoped 之前，不得用第二门店登录扩大柜台
能力面。

### 6. 契约冻结与历史边界

本实现明确修改 `packages/contracts/test/m2-freeze.test.ts`：

- command 新增 `store.profile.set`，总数 43 → 44；
- query 新增 `store.authorized.list`，总数 29 → 30；
- 两者均不进入 `M2_READ_ONLY_AI_DEFINITIONS`，离线模式均为 `denied`。

新增 expand-only `0049_cloud_owner_operations.sql`：为 `stores` 增加正整数
`profile_version`，并由触发器只在 code/name/timezone 业务字段变化时单调增长，调用者不能直接
篡改版本。0048 代码忽略新列，既有 INSERT 使用默认值，因此代码回滚可保留 0049 数据库。
历史订单、支付、会员账本和报表快照均不因门店改名而重写。

## 验收

1. 契约严格拒绝多余键、客户端 org/store、无效名称/时间戳和超界结果；freeze 为 44/30，AI
   投影不扩大。
2. 单元与真实 PostgreSQL 证明 admin/staff RBAC、逐店重新授权、跨组织/未授权隔离、200/50
   上限、当前门店唯一、门店名称 CAS、陈旧写失败、R5 step-up、审计同事务和回滚；非首店会话
   对未动态化的柜台、照片、打印与 Edge 面失败关闭。
3. Browser 证明公网 Owner 三页 IA、今日/日期/月结/职员/渠道报表、R3 导出、授权门店列表、
   重新认证切店、当前门店改名刷新和员工 R5 治理；错误、空态与注销不保留前一门店数据。
4. 完整 `workspace-check`、真实 PostgreSQL、精确 merge-SHA required CI；hk-vps 继续以 marker、
   schema、API、Cloud Chromium、安全边界和合成数据清理形成独立关闭证据。

## 后果

- Owner 从 LAN 只读卡片升级为 Cloud Web 正式经营入口，报表与柜台继续共用同一账本口径。
- 跨店切换多一次密码认证，但不会产生组织级超级会话或跨店审计归属错误。
- 门店显示名称可安全治理；门店创建、时区和更广设置仍需后续独立数据/运维边界。
- LAN Runtime 与桌面/硬件门禁不随本片扩大，Stage 3.2 的 Cloud 证据不能冒充这些后置验收。

## 否决的备选

- **复制一套 Owner 报表查询**：会形成双账本口径，否决。
- **在门店管理命令里接受 target store**：会绕过会话租户并把审计写到源门店，否决。
- **新增组织级 owner 超级角色**：现有角色、会话、RLS 和审批均未冻结该权威，否决。
- **免密切换门店**：扩大公网被盗会话的横向范围，且难以保证刷新族和员工目录原子切换，否决。
- **直接开放 timezone/feature/settings 任意键**：业务日期和模块依赖尚未整体改为动态门店配置，
  且任意设置面不可审计解释，否决。
