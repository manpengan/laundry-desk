# ADR-36 Web 产品收口验收记录

> 日期：2026-08-09
> 当前状态：**ADR-37 阶段 1 已通过并关闭（2026-08-11）**
> 当前已部署验收基线：`7989206b3e9748b2a607687466ef2e0775ad528e`
> 历史基线：`ae9808ce1f3dc61535dbcc1cb89e618f0350ecf6`
> 执行计划：[ADR-36 Web 产品收口计划](../plans/2026-08-09-adr36-web-product-convergence-plan.md)
> 环境边界：[ADR-36](../../adr/2026-08-09-adr-36-cloud-test-environment.md)
> 发布结果：[hk-vps 阶段 1 发布结果](../../operations/2026-08-11-stage1-release-result.md)
> 当前路线：[ADR-37](../../adr/2026-08-10-adr-37-cloud-web-primary-delivery.md)；阶段 1 已关闭，阶段 2 实现候选已通过本地 checkpoint，云发布 pending
> 阶段 2 独立记录：[柜台可信性验收](2026-08-11-stage2-counter-trust-acceptance.md)

## 1. 记录规则

- 只记录当前基线上可复现的新鲜证据；历史本地 E2E 不自动等价为云端验收。
- **通过**表示本行的所有必验项已具备证据；**pending** 表示尚未执行、证据不全或仍待修复。
- 单次基线的整体状态取最弱必验项；历史 `ae9808c` 表格中的 pending 不得冒充新基线证据。
- 不记录密码、token、cookie、私钥、数据库口令或真实顾客 PII。

### 1.1 ADR-37 阶段 1 进入快照

2026-08-10 路线切换时，本地 `origin/main` 为 `6609c5e3e132b13b3721b6848920380eb2ab9bb2`，
仓库迁移头为 `0046`；hk-vps release marker 仍为本记录的 `ae9808c`，数据库停在 `0045`。
这是阶段进入时的只读差异快照，不是失败或部署完成证据；本次文档治理没有部署、重启或
写入云数据库。

ADR-37 阶段 1 关闭前，必须在下表之外追加目标 `main` 的独立证据：

| 增量必验项                 | 进入状态    | 关闭条件                                                                |
| -------------------------- | ----------- | ----------------------------------------------------------------------- |
| 目标 main 精确发布与迁移   | **pending** | marker/运行 SHA/仓库 SHA 一致；数据库到目标迁移头；服务、监听和 KB 健康 |
| 安全公网浏览器只读 UI 子集 | **pending** | 唯一 run-id；`core_ui_subset` 通过；零产品命令；无需业务数据清理        |
| 历史催取正向 fixture       | **pending** | 30/90/180 天候选和名单/导出通过；fixture 可审计、可清理                 |
| P2-1 至 P2-4 新基线复核    | **pending** | HTTP、UI、数据库/审计证据分层通过                                       |

浏览器子集不执行完整业务纵向，也没有单独关闭阶段的权限；完整业务由 ADR-36 公网 HTTP
acceptance（含受控历史催取 fixture）证明。两层都通过后才能更新阶段状态。

以下 `ae9808c` 表格保持历史事实。新部署不得覆盖或冒充它；应追加目标 SHA、时间、run-id 与
边界后再更新阶段状态。

### 1.2 ADR-37 阶段 1 关闭证据

2026-08-11，`main` 合并点 `7989206b3e9748b2a607687466ef2e0775ad528e` 的主干
[V2 Foundation](https://github.com/manpengan/laundry-desk/actions/runs/31457099792) 与
[V2 PostgreSQL Integration](https://github.com/manpengan/laundry-desk/actions/runs/31457099795)
均为 success。该 SHA 随后在 hk-vps 完成 `prepare → finalize`，发布后独立审计如下：

| 增量必验项                 | 状态     | 新鲜证据                                                                                                   |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| 目标 main 精确发布与迁移   | **通过** | marker 精确为 `7989206…28e`；46 条迁移，head `0046_print_job_request_idempotency.sql`；transition `stable` |
| 安全公网浏览器只读 UI 子集 | **通过** | `CLOUD-BROWSER-20260811T041932326Z-5790902a`；`test_status=PASS`、1 test、0 retry、零产品命令              |
| 历史催取正向 fixture       | **通过** | API run `ADR36-20260811T041909981Z-b1e7b1ac` 的 `reminder_history PASS`；同一 run 的 `safe_cleanup PASS`   |
| P2-1 至 P2-4 新基线复核    | **通过** | API 15/15 PASS；Browser 读面 PASS；committed evidence authoritative 且 retention valid                     |
| 服务、路由与同机 KB        | **通过** | Desk/PostgreSQL/Caddy/KB active、failed units 0；Desk 与 PG 仅 loopback；Desk/SPA/KB 公网健康              |

P2-1 至 P2-4 在**阶段 1 定义的分层口径**下全部关闭：

| 行   | 新基线结论                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------ |
| P2-1 | `dual_admin_auth`、`staff_credentials`、`catalog_price` API PASS；工作台、价目与顾客读面可达           |
| P2-2 | `cash_order_fulfillment`、`accounting_today_delta`、`order_finance` API PASS；欠款、生产与账务读面可达 |
| P2-3 | `member_lifecycle` API PASS；顾客读面可达                                                              |
| P2-4 | `reporting_exports_shift`、`reminder_history` API PASS；催取与账务读面可达                             |

Browser subset 仍没有独立关闭权，也不声称逐个 UI 写操作都执行过；完整写纵向、30/90/180 天
fixture、审计回读与安全清理由 API evidence 提供。两层绑定同一 release identity 后共同构成
本次公网 Web 证据。发布后 live marker、schema、服务、监听、KB、公网 health、committed history
及临时凭据清理均复核通过，详见发布结果记录。

## 2. 基线与 P0 证据

| 必验项            | 状态     | 新鲜证据                                                                                                         | 边界                          |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Git 基线          | **通过** | 本地 `HEAD` 与 `origin/main` 均为 `ae9808ce1f3dc61535dbcc1cb89e618f0350ecf6`                                     | 仅证明代码基线                |
| 必需 CI           | **通过** | `workspace-check` 与 `real-postgres` 对该 SHA 均完成且成功                                                       | 不代替远端行为                |
| 发布身份          | **通过** | hk-vps `/opt/laundry-desk/.laundry-release.json` 的 `git_sha` 精确为该 SHA                                       | 不代表生产发布                |
| 服务与路由        | **通过** | `laundry-desk`、`postgresql`、`caddy`、`kb-web` active；loopback 与公网 `/health` ready；KB health 正常          | 同机 KB 不得被部署破坏        |
| 网络边界          | **通过** | Fastify 仅 `127.0.0.1:8787`；PostgreSQL 仅 loopback `5432`；公网仅 80/443                                        | 未验证生产容量/SLA            |
| 认证负例          | **通过** | 畸形登录与有效用户错误密码均返回等价 401/无 cookie；服务端日志分别记录 `LOGIN_REQUEST_INVALID` 与 `LOGIN_FAILED` | 内部 reason code 不进公网响应 |
| 公网最小冒烟      | **通过** | login → refresh → query → 唯一合成顾客写入/回读 → logout                                                         | 不代表完整业务链              |
| loopback 最小冒烟 | **通过** | 同一路径在 `127.0.0.1:8787` 通过                                                                                 | 用于区分应用与 Caddy/公网问题 |

P0 结论：目标 SHA 已精确发布，公网和 loopback 的最小认证/读写路径可用。这个结论不扩大到 P2。

## 3. P2 全业务验收矩阵

| 编号 | 必验纵向                                           | 状态                      | 当前证据与缺口                                                                                            |
| ---- | -------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| P2-1 | 双管理员、员工凭据与价目                           | **HTTP 通过，UI pending** | 双管理员独立登录/step-up；员工创建、creator-bound 完成、重置、旧凭据撤权、新凭据生效与停用；价目快照通过  |
| P2-2 | 开单—部分收款—履约上架—取衣补齐—退款/交班          | **HTTP 通过，UI pending** | 部分现金、件级流转、错误条码零副作用、欠款补缴、只追加退款账本与幂等重放；历史空日交班且当天保持开放      |
| P2-3 | 会员档位—充值赠送—余额支付—本金退款—冻结/解冻/关户 | **HTTP 通过，UI pending** | 冻结时同一资金操作返回 `INVARIANT_FAILED` 且账户/订单零变化，解冻后成功；其余生命周期与档位停用通过       |
| P2-4 | 催取候选、人工名单、双口径报表与导出               | **部分通过**              | 今日/当月/职员双口径与日/职员 CSV 通过；历史空日为零且可交班；30/90/180 天候选、名单/导出仍需历史 fixture |
| P2-5 | 剩余 SQL capturing doubles 的真 PG 证据边界        | **通过**                  | 36 个 case 已逐文件分类；完整隔离真库 828/828、0 failed、0 skipped；workspace 门禁通过                    |

### 3.1 公网 HTTP 验收

2026-08-09 在部署基线 `ae9808c` 上执行 `ADR36-20260809T141222752Z-f6c5d218`。脚本只输出
run-id、旅程状态和稳定错误码，不输出凭据、Cookie、token、手机号或响应体。

| 旅程                    | 结果        |
| ----------------------- | ----------- |
| configuration           | PASS        |
| dual_admin_auth         | PASS        |
| staff_credentials       | PASS        |
| accounting_baseline     | PASS        |
| catalog_price           | PASS        |
| synthetic_customer      | PASS        |
| cash_order_fulfillment  | PASS        |
| member_lifecycle        | PASS        |
| accounting_today_delta  | PASS        |
| order_finance           | PASS        |
| reporting_exports_shift | PASS        |
| reminder_history        | **BLOCKED** |
| safe_cleanup            | PASS        |
| session_logout          | PASS        |
| overall                 | **BLOCKED** |

`overall BLOCKED PARTIAL_ACCEPTANCE_ONLY` 是预期的失败关闭结果，不是全 P2 通过。运行后确认
合成员工已停用、价目已停用、订单归零、会员关户、会话已登出、VPS 临时目录为零；部署 marker
仍为目标 SHA，四个服务 active、failed units 为 0，desk 内外 health 与 KB health 为 200，
PostgreSQL 仍只监听 IPv4/IPv6 loopback。

本次还证明：员工重置后的旧 bearer、refresh 和 password 均失效；旧价订单不被改价污染；
退款、确认和交班用同一幂等引用重放不重复记账；冻结会员的同一余额支付在冻结时失败且
账户/订单快照不变，解冻后才成功；CSV 按原始 UTF-8 字节、BOM/CRLF、逐行内容和 SHA-256
验证。历史空营业日从固定保留窗口选择并回读，今天没有被关闭。

### 3.2 SQL capturing doubles 分类

目标不是机械清零 mock，而是让证据与被测责任一致。剩余业务 doubles 如下：

| 文件                         | case 数 | doubles 只保留的代码侧证据                                  | 数据库侧真源                                                          |
| ---------------------------- | ------: | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `catalog/pg-catalog-store`   |       3 | 空结果、row mapping、错误翻译                               | `pg-catalog-upsert` 的持久化、更新、停用与审计                        |
| `customer/pg-customer-store` |       9 | mapping、参数整形、scope 前置校验、错误翻译                 | `pg-customer-search`、`pg-customer-member-merge`、隐私/RLS 真库测试   |
| `order/pg-order-store`       |      10 | 多结果 mapping、参数与单语句/N+1 边界、错误翻译             | `pg-workday`、`pg-order-summaries` 的事务、状态、付款、排序与并发     |
| `photo/pg-photo-store`       |       3 | 参数、单语句和错误翻译                                      | 同文件 opt-in 真 PG 的元数据/审计原子性、删除及引用驱动 orphan sweep  |
| `print/pg-print-store`       |       3 | claim/list 参数与 PG 错误映射                               | `pg-print-claim`、`pg-print-dispatch`、`pg-print-list` 的并发与持久化 |
| `shift/pg-shift-store`       |       8 | 聚合 mapping、scope/日期校验、参数与错误翻译                | `pg-shift-queries` 的门店隔离、营业日、账目聚合与关闭行为             |
| **合计**                     |  **36** | 没有排序、过滤、约束、持久化、事务、并发或 RLS 只由文本证明 | 真实 PostgreSQL 套件为数据库行为权威                                  |

本轮另补 `stats/pg-source` 的现金支付/退款/冲正、会员本金/赠金与跨店隔离真库回归，并补照片
审计失败原子回滚及文件引用清理。最终隔离 PostgreSQL 套件 828/828、0 skipped；本地
`pnpm workspace:check` 以及云验收脚本 32/32 均通过；TypeScript、数据库与安全终审均
`APPROVE`，未发现本轮 Cloud harness 与 #152 真库证据实现中的剩余 P0/P1/P2。对历史
`ae9808c` 基线，P2 产品验收仍以 §3 矩阵为准，当时历史催取和远端浏览器只读
`core_ui_subset` 均 pending；新基线已按 §1.2 关闭。UI 子集始终只证明核心页面可达且没有
产品命令，不替代 HTTP 纵向。

## 4. 已知验收约束

1. 现有 Web Playwright 的 global setup 直接依赖本地 PostgreSQL、固定员工/催取/账务 fixtures，不能原样指向 hk-vps 共享库。
2. 催取候选要求订单已达 30/90/180 天；新建 UI 数据无法立即覆盖，必须先有受控、可审计的时间 fixture 路径。
3. 共享云库上不关闭当天营业日。当前已在固定保留窗口选择唯一历史空日完成交班与幂等回读；没有受控历史流水 fixture 时不扩大到非零往日交班。
4. VPS 没有现成 Chromium，且本地 Playwright setup 会改写数据库；专用公网 Playwright
   只能运行零命令的只读 `core_ui_subset`。公网 API 与 UI 证据分层记录，不把任一层冒充
   另一层。
5. 2026-08-09 静态盘点（45 迁移/41 命令/25 查询/436 test-spec 文件）与 CI 双绿都不能替代上述 P2 行为证据。

## 5. 外部门禁（不纳入本记录收口）

| 门禁                         | 当前表述                                    |
| ---------------------------- | ------------------------------------------- |
| Developer ID/公证/Gatekeeper | 未有正式外部证据，不与本地 ad-hoc 包等同    |
| 正式签名双架构 OCI           | 未发布，不与 hk-vps 裸机测试环境等同        |
| XP-58 实体打印               | 软件 fake CUPS/ESC-POS 证据不等于真实出纸   |
| Windows 打包/实机            | 依 ADR-37 移出 Cloud Web 1–4 关键路径       |
| 生产级云部署                 | hk-vps 仅是可随时丢弃的合成数据开发测试环境 |
