# laundry-v2 统一架构设计（产品化 + AI 能力层）

> 版本：v2.0-**draft3.1a**　日期：2026-07-19　作者：Claude（设计与门禁）
> **状态：定稿**——总 RFC 与 ADR-01…08 已于 2026-07-19 全部 Accepted；本文件即 v2 设计真源，后续变更走新增 ADR。
> draft3.1a 修订（终审补丁）：P0-1 **Primary lease 可信时间契约**（签名 `lease_id/issued_at/ttl_ms/max_clock_skew_ms`、单调钟计时、时间连续性不可证则 fail-closed、离线命令绑定 `lease_id+epoch+per_lease_seq`，§10/§11）；P0-2 修复 §13.3 与 §13.5 的回滚表述冲突；P1 同步（Edge 兼容窗口改"当前及上一 contracts major"、§16 晋升表述、RLS 模板补 WITH CHECK、ADR 引用 01…08）。
> draft3.1 修订（Codex 三审四项 P0 + P1 + 用户裁定）：①店级组合外键升三元 `(org_id, store_id, id)`，garments→order_lines 含 order_id（§4/§7）；②Primary lease 与 offline grant 分离、离线退款禁用、解绑改"服务端吊销原子/本地擦除 best-effort"（§10/§11）；③桌面断网冷启动（内置签名 SPA + app:// 协议）+ Electron 安全基线（§13.3）；④Edge 升级状态机（A/B 槽/快照/队列信封版本化/回滚判定/最低安全版本，§13.5）。P1：票号去"单调"改 ULID 排序、N-1 定义为 contracts 协议 major、LTS 渠道与支持矩阵、远程协助收紧。**用户裁定：桌面为主、Web 次之，前期以本地 web 服务（单机模式）做测试适配**。发布/升级体系独立为 ADR-08。
> draft2 修订：吸收 Codex 一轮二审 P0——AI 基座前移 M1、RLS 前移 M1、免确认改有边界自动化、Edge Agent 重构、SSRF 硬化、order_lines/garments 拆分、方案 B 里程碑。
> draft3 修订（契约级补丁，非全文重写）：吸收 Codex 二轮二审六项 P0——①租户列/组合外键/策略模板/旁路负向测试（§4、§7）；②Edge 签名方向 + offline grant + DEK/KEK 分离 + **Primary Edge 防双花**（§10、§11）；③BYOK 密钥契约固化（§9.7）；④审计同事务/仅 INSERT + canonical args 冻结 + AI 数据治理（§6.5、§8、§9.5、§9.8）；⑤票号不变量改"唯一·单调·永不复用"（§6.1、§7）；⑥R4 拆同步 step-up（M1）/异步审批中心（M5）。另新增 §13 发布/升级/技术支持与桌面端同步开发；P1 四项（会话/CSRF、命令元数据、支付只追加、UI 数量残留）一并落地。
> 上游输入：
> - `docs/research/2026-07-19-shunke-review-feature-matrix.md`（顺科功能矩阵与实际使用度）
> - `docs/research/2026-07-19-laundry-core-features-and-competitive-research.md`（竞品调研 + P0–P3 产品蓝图）
> - `docs/superpowers/specs/2026-04-23-laundry-desk-design.md`（v1 设计真源，本文件不替代其对 M1–M4 收口的约束）
> 配套：`2026-07-19-laundry-v2-web-ui-design.md`（UI）；`docs/adr/2026-07-19-v2-productization-and-ai.md`（总 RFC，下辖 ADR-01…08）
>
> 本文件是设计，不含实现代码。实现由后续指派的 AI（Claude/Codex/Gemini/Grok 组合）按 §15 的分工机制执行。

---

## 0. 一页总览

```text
┌────────────────────────── 客户端 ──────────────────────────┐
│ 柜台工作台(Web)  老板端(H5/PWA)  顾客小程序(微信)  工厂/员工端(H5) │
└────────┬──────────────┬───────────────┬──────────────┬────┘
         │(人工操作)      │               │              │
┌────────▼──────────────▼───────────────▼──────────────▼────┐
│              API 网关 (Fastify · Zod 信封 · OpenAPI)         │
│         Auth(JWT+RBAC+PIN)  RateLimit  幂等键  审计          │
├───────────────────────────────────────────────────────────┤
│   AI Operator Runtime ──→ Policy / Risk Engine (R0–R5)      │
│   (单一运行时,六预设)      │  Dry-run · 确认卡 · 审批 · 自动化策略 │
│                          ▼                                 │
│        ★ 统一 Command / Query Bus（唯一写入口）★             │
│   人工按钮 = AI 工具 = 自动化策略 = 离线回放 → 同一命令        │
├───────────────────────────────────────────────────────────┤
│                领域服务层（14 模块，见 §6）                    │
├──────────────┬────────────────────────────────────────────┤
│  AI Gateway  │  集成适配层：微信 · 短信 · 聚合运力 · 团购核销    │
│  BYOK/注册表/ │  · 支付通道（全部 adapter，不硬绑厂商）          │
│  出口白名单   │                                             │
├──────────────┴────────────────────────────────────────────┤
│ PostgreSQL 16（多租户 + RLS 强制） 对象存储  队列(PG起步)      │
└───────────────────────────────────────────────────────────┘
         ▲ 127.0.0.1 WSS（Origin 白名单 + 每消息签名）
┌────────┴─────────────────────────────────────────────────┐
│ Local Edge Agent（桌面常驻）：加密 SQLite 离线队列 · 签名模板   │
│ 本地渲染 · 打印(小票/水洗唛/不干胶) · 扫码 · 钱箱票据 · 秤      │
└──────────────────────────────────────────────────────────┘
```

八条硬约束：

1. **金额全程整数分**，禁浮点。
2. **单件衣物（garment）是最小流转对象**：每件一条记录、唯一条码，`qty` 只存在于订单行（§7）。
3. **所有边界过 Zod**，统一信封 `{ ok, data } | { ok, error }`。
4. **模块 per-store 可开关**——同一套软件适配夫妻店到工厂店。
5. **写操作只有一个入口**：统一命令总线。人工点按钮、AI 工具、自动化策略、离线回放走同一条校验链（§7 前置的 §6.5）。
6. **AI 权限 ≤ 操作者权限，且按 R0–R5 分级**；R5 对 AI 不存在；无全局免确认。
7. **柜台断网可开单**——离线态由 Local Edge Agent 承载，浏览器不持有敏感离线状态（§11）。
8. **数据是店主的**——可导出、可还原、本地+云双备份、RLS 强制隔离。

## 1. 目标与非目标

**目标**：laundry-desk 升级为可交付洗衣店行业的产品；**AI-first**——AI 不是附加模块，而是与人工共用同一命令入口的第一类操作者，从 V2-M1 起进入基座。覆盖竞调 P0/P1 功能蓝图 + BYOK 多厂商大模型接入。

**非目标**（接口预留、v2 不做）：RFID 硬件集成、取衣柜自铺、输送线控制、刷脸支付、多级分销、自建运力、洗衣机 IoT。

**兼容承诺**：宏发 v1 的 M1–M4 收口不因 v2 打乱；v1 数据一次性迁移（§14）。

## 2. 形态决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 主形态 | 技术上 Web-first（一套 SPA + 云端 API）；**交付上桌面为主、纯浏览器次之**（用户裁定）——桌面壳内置本地资产可断网冷启动（§13.3）；前期开发以**本地 web 服务（单机模式）**做测试适配 | 柜台主战场 = 桌面 + 硬件 + 离线；但用 Web 技术栈避免走顺科桌面单机停止进化的老路 |
| 桌面端 | **Local Edge Agent**（Electron 常驻，托盘 + 自动更新） | 不止是打印桥：加密离线队列、签名模板本地渲染、硬件授权票据（§10）。协议独立，未来可换 Tauri |
| 离线 | Edge Agent 承载离线交易；浏览器仅缓存 UI/字典 | 断网即瘫是竞品红线；但浏览器 IndexedDB 不该承担交易/审计（Codex 二审结论） |
| 部署 | 同一 codebase：云端多租户 SaaS（主线）/ 单店自托管（docker compose） | 数据归属是信任卖点 |
| 顾客端 | 微信小程序（原生） | 国内标配，对标 QDC IM-原生范式 |
| 老板端/员工端 | 响应式 Web 按角色出 IA | 降低维护面 |

## 3. 技术栈

| 层 | 选型 | 备注 |
|---|---|---|
| 语言 | TypeScript 全栈 `strict` | 类型即契约 |
| 前端 | React 18+ + Vite + TanStack Query + Zustand | |
| UI | 自有设计系统（液态玻璃 tokens → `packages/ui`） | |
| 服务端 | Node.js 22 + Fastify | |
| 命令层 | **自研轻量 Command/Query Bus**（§6.5），不引入重型 CQRS 框架 | 核心是注册表+校验链，百行级实现 |
| 契约 | Zod 单一真源 → OpenAPI 3.1 → 各端类型生成 | 契约含命令/查询/风险等级/工具描述 |
| ORM | Drizzle（PG 方言） | |
| 数据库 | PostgreSQL 16 + **RLS（M1 起强制）** | §4 |
| 队列 | PG（SKIP LOCKED + LISTEN/NOTIFY）起步，量大再 Redis | 打印/通知/AI/回放共用抽象 |
| 对象存储 | S3 兼容（OCI / MinIO） | 照片、备份、导出 |
| 实时 | SSE（AI 流式/看板）；Edge Agent 用本地 WSS | |
| 鉴权 | argon2id + JWT access(15min，仅存内存)/refresh(14d，httpOnly+SameSite cookie 轮换) + **CSRF 双提交头（命令类 POST 必带）** + 柜台 PIN 快切；小程序 code2session | Web 会话/CSRF 契约随 contracts 冻结 |
| 可观测 | pino + OpenTelemetry + /metrics | |
| 测试 | Vitest ≥70% + Playwright + 契约测试 + **跨租户负向测试** + **AI 红队用例集** | 门禁项 |
| Monorepo | pnpm workspaces + Turborepo | §5 |

## 4. 多租户与 RLS（M1 落地，不推迟）

```text
org（品牌）─ store ×N ─ staff ×N（可跨店）·  device ×N（Edge 实例）
factory（可属 org 或独立协作方）    customer（org 级共享）
```

- **隔离双保险，M1 同时上线**：
  1. 服务层强制注入租户过滤（第一道）；
  2. **Postgres RLS（第二道，默认拒绝）**：所有租户表 `ENABLE ROW LEVEL SECURITY` **且 `FORCE ROW LEVEL SECURITY`**（表所有者默认绕过 RLS，必须显式 FORCE）；应用连接使用**非表所有者角色** `laundry_app`（NOBYPASSRLS），迁移用独立 owner 角色；策略基于会话变量：每事务 `SET LOCAL app.org_id / app.store_id / app.staff_id`，连接池按事务注入；**后台任务与队列 worker 走同一 GUC 注入**，禁止裸连接查询。
- **租户数据模型可执行化**（draft3.1 升为三元）：业务表直接持有 `org_id`（店级表再持 `store_id`），子表冗余租户列并用**三元组合唯一键 + 组合外键 `(org_id, store_id, id)`** 防跨租户**与跨门店**挂靠（二元 `(org_id, id)` 只防跨品牌，废弃；见 §7 租户列规则）；RLS 策略模板只有 org 级/店级两种，均为**本行字段与 GUC 的简单比较**，禁止跨表子查询策略（复杂且有并发一致性风险）；**模板同时包含 USING（读）与 WITH CHECK（写入约束）两半，M1 一并冻结**（draft3.1a）；tenant-scope 表矩阵（org 级/店级/全局字典三类）随 contracts 冻结。
- **租户上下文只来自服务端认证会话注入**：浏览器、LLM、Edge 自报的 org/store 一律忽略。
- **负向测试进 CI 门禁**（draft3 扩充）：租户 A 凭证访问租户 B 数据必须 0 行/拒绝，覆盖 API、队列任务、报表导出三条路径；另加五类旁路用例——**GUC 未设置（必须查不到任何行，而非报错放行）、GUC 空值、事务回滚后 GUC 残留、连接池复用串租户、worker 漏注入**。
- 性能对策：策略条件全部命中 `(org_id, …)` 复合索引；M0 验证期实测 RLS 开销（§14）。
- 计费粒度 per-store；定价策略学 QDC/CleanCloud（免费额度 + 按单量分档），价格表不属本文件。
- Feature flags：`store_features`（`fulfillment / membership / shift_closing / delivery / marketing / ai`）。

## 5. Monorepo

```text
laundry/
├─ apps/ web · server · edge-agent · miniprogram
├─ packages/
│  ├─ contracts/   # Zod schemas + 命令/查询注册表定义(含风险等级、工具描述) + OpenAPI
│  ├─ domain/      # 纯函数：计价、状态机、账目口径（零 IO，100% 单测）
│  ├─ ui/          # 设计系统
│  └─ config/
├─ docs/  └─ tools/（migrate-v1、种子、脚本）
```

## 6. 模块边界与统一命令总线

### 6.1 模块清单

| 模块 | 职责 | 关键不变量 | 开关 |
|---|---|---|---|
| identity | org/store/staff/device、RBAC、PIN 快切 | 高危权限独立位 | 常开 |
| customer | 散客档案、标识、多地址、豁免开关 | 手机号 org 内唯一（可空） | 常开 |
| membership | 卡类/发卡/储值/次卡/积分/挂失合并退卡 | 余额只能由 ledger 派生 | `membership` |
| catalog | 服务×品类二维价目、助记码、字典 | 价格版本快照 | 常开 |
| order | 票单 + 订单行 + 件、暂存、撤销（必填原因） | 票号门店内**唯一·永不复用**（空洞与离线乱序可审计；时间排序用 ULID，不依赖票号） | 常开 |
| payment | 收款 ledger、部分付款、欠款、保管费 | 每笔一条 ledger 记 staff；**流水只追加，更正走红冲分录**（无 UPDATE/DELETE） | 常开 |
| fulfillment | 送洗/上挂/格位、店厂批次交接、工序 | garment 状态机唯一写入口 | `fulfillment` |
| notification | 微信/短信 adapter、12 节点、催取三档、**降级名单** | 全量 notification_log | 常开（通道可关） |
| delivery | 取送单、聚合运力 adapter | 调用幂等可人工接管 | `delivery` |
| marketing | 券/满减/套餐/单层推荐、Flow | 核销幂等 | `marketing` |
| accounting | 科目、日/月/职员、交班、双口径 | 只读 ledger 派生 | `shift_closing` 可关 |
| printing | 三类模板（签名分发）、任务队列、补打 | 任务落库可追溯 | 常开 |
| reporting | 看板、导出、对账 | 与 accounting 同 domain 函数 | 常开 |
| ai / platform | §9 / 设置、flags、备份还原、审计查询 | | `ai` / 常开 |

模块间只走 service 接口；跨模块一致性 = 同事务或队列补偿。`fulfillment` 关闭时件状态机坍缩为 `received → picked_up`。

### 6.5 统一 Command/Query Bus（M1 基座，AI-first 的根）

**问题**：若页面直调 service，M1–M4 会积累大量"只能给页面用、不能安全给 AI 用"的接口。**解法**：所有写操作注册为**领域命令**，所有读操作注册为**查询**；UI 按钮、AI 工具、自动化策略、Edge 离线回放走同一入口。

```text
命令定义（contracts 包，draft3 补齐元数据）:
  { name, version, input: ZodSchema, risk: R0–R5, description(给人+给LLM),
    invariants[], idempotent: bool, sideEffects[],
    offline_allowed: bool,                       # 是否允许进离线队列（§11）
    data_classification: public|internal|pii,    # 驱动脱敏与日志策略
    max_batch?: number,                          # 批量上限（触发 R3→R4 升级阈值）
    result_redaction?: 脱敏规则 }                 # 返回给 AI/日志前的字段处理

命令信封（每次执行）:
  { command, version, args, actor: {staff_id, device_id, via: ui|ai|automation|edge_replay},
    tenant: {org_id, store_id}, idempotency_key, dry_run: bool, confirm_ref?: nonce }

校验链（顺序固定，任何入口不可跳过）:
  Zod schema → RBAC(actor.staff) → 租户/数据范围(与 RLS 双保险) →
  Policy/Risk Engine(按 via+risk 决定: 放行/要求确认卡/要求审批/拒绝) →
  业务不变量(dry_run 在此返回预演结果) → 事务执行【业务变更与审计写入同一数据库事务，
  审计写入失败则业务整体回滚】 → 领域事件
```

- **AI Tool Registry = 命令/查询注册表的投影**：不存在第二套工具实现。投影时附加 LLM 用描述、示例、参数脱敏规则；每个 AI 预设（§9.4）持有白名单子集。
- **风险等级 R0–R5**（Policy Engine 的输入，采纳二审分级）：

| 级 | 示例 | 执行方式 |
|---|---|---|
| R0 | 操作帮助、生成文案草稿 | 自动 |
| R1 | 营业额/件数/滞留统计 | 自动，回答附数据来源与筛选条件 |
| R2 | 顾客/订单/员工业绩等敏感读取 | 权限校验 + 脱敏 + 数量上限 |
| R3 | 改备注、生成催取任务、保存草稿、小批量通知（≤阈值） | 单次确认卡；可被自动化策略在限额内授权 |
| R4 | 退款、免单、改价、大批量通知、发券、客户合并 | 确认卡 + **step-up 复核**：具备审批权限的身份（店长/老板）现场 PIN/扫码同步复核（M1 起可用，原子单次消费）；M5 增加异步审批中心 |
| R5 | 改权限、密钥管理、备份恢复、删除审计、RLS/系统设置 | **AI 不可执行**——不进入 Tool Registry 投影，仅人工 UI |

- **风险随参数升级**：数量/金额越阈值自动 R3→R4（如批量通知 >50 人、单笔调整 >100 元）。阈值 per-org 可配但只能调严不能调松出厂线。
- 版本化：命令 semver 进信封；契约包冻结流程见 §15。

## 7. 数据模型（核心 ERD，draft2 修正件级拆分）

ID 一律 ULID；`timestamptz` UTC；金额 `integer` 分。

**租户列规则（draft3.1 修正为三元组合，支撑 §4 的 RLS）**：org 级表首列 `org_id`；门店级表再带 `store_id`；**子表冗余父表租户列并以三元组合约束防跨租户与跨门店挂靠**——

```text
orders      UNIQUE(org_id, store_id, id)
order_lines UNIQUE(org_id, store_id, order_id, id)
            FOREIGN KEY(org_id, store_id, order_id)          REFERENCES orders(org_id, store_id, id)
garments    FOREIGN KEY(org_id, store_id, order_id)          REFERENCES orders(org_id, store_id, id)
            FOREIGN KEY(org_id, store_id, order_id, order_line_id)
                                                             REFERENCES order_lines(org_id, store_id, order_id, id)
            # ↑ 含 order_id：防止衣物挂到同门店另一张订单的计价行
payments / garment_status_log / print_jobs / ticket_no_blocks 同构（均含 org_id, store_id 组合外键）
```

二元 `(org_id, id)` 只防跨品牌、不防同品牌跨门店，**废弃**。RLS 策略只比较本行 `org_id/store_id` 与 GUC。下方 ERD 为省篇幅仅在关键表显式标注租户列，**实际所有租户表遵守本规则**；三类表矩阵（org 级 / 店级 / 全局字典无租户列）随 contracts 冻结（M1）。

```text
orgs / stores / staffs / staff_store_roles / devices / store_features

customers(org_id, name, phone, gender, tags[], is_blacklisted,
          skip_ticket_print, skip_label_print, fixed_discount_pct?, …)
customer_addresses(…)

card_types / member_cards / member_ledger(kind: topup|gift|consume|refund|adjust|expire,
          principal_cents, gift_cents, …)      # 余额=SUM(ledger)
punch_cards / points_ledger

service_types(store_id, code, name, hotkey, sort)
item_catalog(store_id, name, mnemonic, category, unit, allow_discount, photo_url,
             wash_route, prices_json, price_b_json)
addon_catalog / color_dict / brand_dict / remark_dict

orders(org_id, store_id, ticket_no, customer_id, status: draft|open|cancelled|closed,
       promised_at, total_cents, discount_cents, addon_cents, urgent_cents,
       freight_cents, payable_cents, source: counter|miniprogram|delivery, version, …)
       # payable 计算唯一落在 packages/domain；version 用于确认卡乐观校验

order_lines(org_id, store_id, order_id, seq, catalog_item_id, item_name_snapshot, service_type,
            qty, unit_price_cents, line_discount_cents, addon_json, …)
            # ← 计价行：品类×服务×数量×单价×折扣

garments(org_id, store_id, order_id, order_line_id, seq, barcode UNIQUE, color, brand, flaws[],
         accessories, style, photo_ids[],
         status: received|washing|ready|racked|picked_up|delivered|reworked|lost,
         rack_zone, rack_slot, rfid_tag_id NULL, …)
         # ← 实物件：每件一条，无 qty。开单 line.qty=3 ⇒ 生成 3 条 garment（各自条码）
garment_status_log(garment_id, from, to, staff_id, device_id, via, at)

payments(org_id, store_id, order_id, method, amount_cents,
         kind: pay|repay|refund|storage_fee|reversal, ref_payment_id?,
         staff_id, at, …)
         # 只追加：无 UPDATE/DELETE；更正 = 红冲分录(kind=reversal 引用原分录)

production_batches / batch_garments（店厂四节点交接）
delivery_orders(…)
coupons / coupon_grants / campaigns / referral_rewards
notification_templates / notification_log
print_jobs(store_id, device_id, kind, payload_ref, status, retries, …)
print_templates(store_id, kind, version, lines_json, copies, timing,
                signature, signed_at)          # 签名分发给 Edge（§10）
shift_closings(…)
audit_log(org_id, store_id, staff_id, via, command, idempotency_key, dry_run,
          entity, entity_id, before_json, after_json, ip, device_id, at)
settings / backups(…, restored_test_at)

# Edge 与授权
edge_devices(store_id, name, device_pubkey, paired_at, last_seen_at, status)
primary_lease_heads(org_id, store_id, current_epoch, current_lease_id,
                    current_not_after, version,
                    PRIMARY KEY(org_id, store_id))
                    # 每店预创建一行；签发/释放/晋升先 SELECT ... FOR UPDATE 本行
primary_leases(org_id, store_id, device_id, lease_id UNIQUE, primary_epoch,
               issued_at, ttl_ms, max_clock_skew_ms, not_after, released_at?, sig,
               UNIQUE(org_id, store_id, primary_epoch))
               # "同店至多一个有效"由 head 行锁串行化保证（§10），不是口头承诺
ticket_no_blocks(store_id, device_id, date, from_no, to_no)   # 离线号段

# AI 域
ai_provider_keys(org_id, provider, base_url_mode: official|custom, base_url?,
                 key_ciphertext, key_last4, status, verified_at, created_by)
ai_model_registry(provider, model_id, display_name, caps_json, enabled, sort)
ai_presets(org_id, kind, model_ref, tool_whitelist[], risk_cap, enabled, params_json)
ai_conversations / ai_messages(tokens_in/out)
ai_pending_actions(nonce UNIQUE, conversation_id, tool, args_json, args_hash,
                   entity_versions_json, operator_staff_id, org_id, store_id,
                   idempotency_key, expires_at,
                   status: pending|confirmed|denied|expired)   # 确认卡后端（§9.5）
automation_policies(org_id, store_id?, tool, filter_json, limits_json
                    {max_per_day, max_amount_cents, time_window}, valid_from,
                    valid_until, approved_by, status: active|paused, created_by)
                    # 只能授权 ≤R3；见 §9.6
approval_requests(org_id, kind, payload_json, requested_by, status,
                  decided_by, decided_at)      # R4 审批中心（M5）
ai_usage_daily / ai_action_log(conversation_id, tool, args_hash,
                  decision: auto|confirmed|denied|policy, staff_id, result_summary, at)
```

**件级状态机**（domain 层显式转移表，唯一写入口；draft2 补 `delivered`）：

```text
received ─→ washing ─→ ready ─→ racked ─→ picked_up   # 到店取走（终态）
                         │         └────→ delivered   # 回送/配送签收（终态）
                         └──(无挂点门店)──→ picked_up | delivered
washing|ready|racked ─→ reworked ─→ washing            # 返工回环
received|washing|ready|racked ─→ lost                  # 高危+赔付分录（终态）
fulfillment 关闭时: received ─→ picked_up | delivered
order: draft ─→ open ─→ closed(全部件到终态且欠款清零) / cancelled(必填原因,回冲)
```

**票号不变量（draft3.1 二次修正，去掉"单调"）**：门店内**唯一、永不复用**；号段空洞**与离线乱序**（多设备预取号段可能先用 101 后用 1）**允许存在但必须可审计**（`ticket_no_blocks` 记录分配、使用与作废）；**时间排序一律以 ULID 主键/`created_at` 为准，不依赖票号大小**。配套规则：营业日按**门店时区**定义，跨零点营业的门店可配营业日切换时刻；未用号段到期回收（仅限从未下发设备使用的段）；**设备解绑其未用号段永久作废，不回收复用**。在线 `YYYYMMDD-NNNN` per-store 事务发号；离线用预取号段（§11）。

## 8. 权限与审计

- 权限点约 40 项分 6 组（系统/会员/日常/统计/财务/**高危**）；高危含：改价、改实收、免单、撤销、删客户、直改余额（仅迁移工具）、保管费减免、挂失赔付、全量导出。
- 角色 = 权限点模板（owner/manager/clerk 预置可自定义）；柜台 PIN 快切保证每笔单据 staff 归属真实。
- 审计由**命令总线统一落**（§6.5 校验链末端），不依赖各 handler 自觉；覆盖率 100% 写操作是契约测试项。
- **审计完整性（draft3）**：业务变更与审计写入**同一数据库事务**，审计失败业务整体回滚；`laundry_app` 角色对 `audit_log` 仅授 `INSERT`（无 UPDATE/DELETE/TRUNCATE——防篡改靠数据库权限而非约定）；审计表本身启用 RLS；查看审计的行为也留痕（访问监控）；审计与日志**不落 token、密钥、完整手机号等非必要 PII**（按命令元数据 `data_classification`/`result_redaction` 执行）。

## 9. AI 能力层

### 9.1 原则

1. **AI 是第一类操作者**：与人工共用命令总线，从 M1 基座就存在（Tool Registry 是命令注册表的投影）。
2. **BYOK**：门店自带 key；平台不转售 token。
3. **Key 永不下发浏览器**、不进日志/错误/对话上下文/明文备份。
4. **AI 权限 ≤ 当前操作员 RBAC**，再叠加 R0–R5 风险策略。
5. **读自动（R1/R2 带脱敏限量）、写确认（R3+）**；无全局免确认；自动化只能通过**有边界策略**（§9.6）。
6. 多厂商、注册表配置驱动。

### 9.2 Provider 适配层

| Adapter | 协议 | 覆盖 |
|---|---|---|
| `anthropic` | Anthropic Messages API（官方 TS SDK） | Claude（adaptive thinking、prompt caching：稳定 system+工具表前置打缓存点；Opus 4.7+ 无 temperature） |
| `openai-compat` | OpenAI Chat Completions | OpenAI、Grok、DeepSeek、Qwen、Kimi、GLM、豆包、自托管 vLLM/Ollama（每厂商一份 endpoint 配置 + 工具调用方言表） |
| `gemini` | Google 原生 API | Gemini（其 OpenAI 兼容端点功能阉割，工具调用走原生） |

统一内部消息格式（text/tool_use/tool_result/image 块）；接口：`chat(stream) / verifyKey / countTokensEstimate`。工具参数一律 JSON 解析 + Zod 校验，禁字符串匹配。

### 9.3 模型注册表（配置驱动；2026-07 出厂快照，实现时校准）

| 厂商 | 出厂默认 | 备注 |
|---|---|---|
| Anthropic | claude-sonnet-5 / claude-opus-4-8 / claude-haiku-4-5 | $3/$15、$5/$25、$1/$5 每 M token（官方口径） |
| OpenAI | GPT-5.6 系（Terra/Sol/Luna） | |
| Google | Gemini 3.1 Pro / 3.5 系 | |
| xAI | Grok 4.5 | openai-compat |
| DeepSeek | V4 chat/reasoner | 大陆直连，默认推荐位 |
| 阿里通义 | Qwen3.6 系 | DashScope 兼容 |
| 智谱 | GLM-5 | |
| 月之暗面 | Kimi K2.6 | |
| 字节火山方舟 | Doubao Seed 1.6 系 | |
| 自托管 | 用户自填（OpenAI 兼容） | 内网场景 |

大陆可达性三对策：SaaS 服务器侧出网调用（主）；官方允许的自定义网关（受 §9.7 硬化约束）；默认推荐大陆厂商。

### 9.4 AI Operator Runtime（单一运行时，六预设）

**不做六套独立 agent。**一个运行时 = 统一 tool-use 循环 + Policy Engine 前置；预设（`ai_presets`）只是 `system prompt + 工具白名单 + 风险上限 + 模型引用 + 入口面` 的数据组合：

| 预设 | 风险上限 | 入口 | 里程碑 |
|---|---|---|---|
| 经营问答（带来源与筛选条件） | R2 | 老板端/柜台抽屉 | M2 |
| 订单/顾客检索助手 | R2 | 柜台抽屉/⌘K | M2 |
| 操作助手（导航+草稿+受限写） | R3→R4 | ⌘K/抽屉 | M2 只读起步，M3 开 R3 |
| 规程与故障排查助手（产品文档 grounding） | R0 | 全局帮助 | M2 |
| 催取助手（滞留分析+文案+确认发送） | R3/R4 | 催取工作台 | M3 |
| 经营分析/异常解释/周报 | R2 | 老板端/报表侧栏 | M4 |
| 视觉：拍照辅助开单（不定价）/ 掉标找衣 | R2 | 开单抽屉/找衣 | M6.1 |

运行循环（server 端自有实现，不绑单一厂商框架）：

```text
loop ≤8 轮:
  adapter.chat(stream) → SSE 转发
  tool_calls? → 逐个: Registry 查投影 → 命令信封(via=ai) → §6.5 校验链
     R0/R1/R2 → 自动执行(脱敏/限量)  
     R3 → 下发确认卡(§9.5) 等待店员决定
     R4 → 确认卡 + step-up 同步复核(M1 起) / 转异步审批中心(M5)
     R5 → 工具不存在（LLM 看不到）
  结果回填 tool_result → 继续
守护: 单轮超时、org 成本限额熔断、每预设速率限制
```

**固定执行链**（每个 AI 动作可回放）：

```text
自然语言 → 识别上下文(当前页面/门店/选中订单) → 生成计划 → 查询或 dry-run
        → WYSIWYS 确认(R3) / step-up 或审批(R4) → Command Bus 原子执行
        → 返回可回放结果 + 审计编号
```

新业务模块只需注册命令与查询，AI 自动获得对应工具——**不存在第二套 AI 逻辑**。

**安全定义**（采纳二审表述）：AI 可以调用**所有已注册、当前操作员有权执行的业务能力**，而不是直接访问数据库、文件系统或操作系统；裸 SQL、任意 URL、硬件原始接口、密钥读取、备份恢复永不投影给 AI。

### 9.5 确认卡（WYSIWYS：所见即所授权）

确认卡不是 UI 装饰，是服务端持久化的授权对象（`ai_pending_actions`）：

- 生成时绑定：`tool + args 完整参数 + args_hash + operator_staff_id + org/store + 涉及实体的 version 快照 + expires_at(默认 5 分钟) + nonce + idempotency_key`。
- **canonical args 服务端冻结（draft3）**：卡创建时完整参数落库为唯一权威副本；店员确认**只提交 `nonce`，客户端不回传参数**；执行时从服务端读取冻结参数。执行前重校验：实体 version 未变（并发修改 → 卡作废）、未过期、操作者与卡一致、RBAC 仍有效；`args_hash` 用于 AI 侧对账与审计（AI 换参数 → 必然生成新卡）。
- 拒绝/过期 → tool_result 回传 LLM（含原因），全程 `ai_action_log`。
- UI 上显示的即被授权的：对象数量、金额、渠道、文案预览必须完整呈现（UI 文档 §4.9）。

### 9.6 有边界的自动化策略（替代"免确认"，M5）

删除原设计的"AI 写操作免确认"全局开关。自动化只能通过 `automation_policies`：

- **范围**：指定工具（仅 ≤R3）、指定门店、对象过滤器（如"滞留>90 天且未催取过"）。
- **限额**：每日次数上限、金额上限、允许时间窗。
- **生命周期**：生效/失效日期、owner 审批后才 active、一键暂停、每次执行落 `ai_action_log(decision=policy)` 并计入限额。
- **绝对红线**（任何策略不可授权，硬编码 deny）：退款、免单、余额调整、权限变更、密钥管理、备份恢复、审计删除。
- 定时触发（如每日 10:00 自动催取）= 策略 + 调度器；超限自动停止并通知 owner。

### 9.7 BYOK Key 管理与出口硬化（SSRF 防护）

- **密钥契约（draft3 固化，不再只写算法名）**：每凭证独立随机 **DEK**（AES-256-GCM）；每次加密唯一 **96-bit 随机 nonce**；**AAD 绑定 `org_id|provider|credential_id|schema_version`**（防密文跨租户/跨凭证挪用）；DEK 由 **KEK 包装**——云端 KEK 在 KMS，自托管 KEK 在 **OS Secret Store（DPAPI/Keychain/secret-service），不与数据库同盘存放**；密文携带 `key_version`，支持 KEK 轮换（重包裹 DEK，不重加密密文）、凭证轮换、吊销与灾备恢复流程；仅显示尾 4 位，保存后任何 API 不回明文。
- **出口白名单默认**：`base_url_mode=official` 时只允许注册表内各厂商官方域名（固定 host 表随注册表分发）。
- **自定义网关是独立授权项**（owner 权限 + 审计）且强制全套硬化：仅 HTTPS 443；禁 IP 直连字面量；DNS 解析后校验目标非 loopback/RFC1918/link-local/CGNAT/169.254.169.254 等 metadata 段（解析与连接同一结果，防 DNS rebinding）；重定向逐跳重新过全套校验；响应体积与时长上限；模型调用走独立 egress 代理出口，网络策略只放行该代理。
- Key 只随通过白名单校验的请求发送；连续鉴权失败自动置 invalid 并通知。
- 用量与限额：`ai_usage_daily` 计量（token/估算成本），org 月度限额熔断；用量看板 M5。
- **交付节奏**：加密存储、verifyKey、官方白名单在 **M2** 随首个 AI 功能一步到位（安全属性不分期）；厂商全矩阵、用量看板、自定义网关授权 UI 在 M5 补全（广度分期）。

### 9.8 Prompt Injection 纵深防御

标注"不可信数据"只是第一层，完整栈：

1. 最小权限：预设白名单 + 风险上限 + 操作员 RBAC 三重收窄；
2. 输入隔离：顾客姓名/备注/微信消息/照片 OCR 一律独立 content 块 + 不可信标注；system prompt 服务端固定；
3. 输出验证：工具参数过 Zod + 业务不变量 + dry-run；
4. 人类闸门：R3+ 确认卡（WYSIWYS）；
5. 监控：工具调用异常模式告警（频率/越权尝试/被拒次数）；
6. **红队用例集进 CI**：注入样本（备注里藏指令、图片藏文字等）断言不产生未授权工具调用——门禁项。
7. PII：`ai.pii_masking` 默认开（手机号打码、证件不送）；关闭需 owner 权限并审计。
8. **AI 数据治理（draft3）**：`ai_conversations / ai_messages / ai_pending_actions / approval_requests` 全部纳入 RLS；字段最小化（对话不落完整客户档案，只引用 ID）；保留期限可配（默认 180 天，到期归档删除）；顾客数据删除请求联动清理相关 AI 记录中的 PII；AI 相关日志同样不落 token/key/完整手机号。

## 10. Local Edge Agent（硬件桥升级版）

桌面常驻进程（Electron 起步，托盘 + 自动更新），职责清单（draft2 扩权）：

| 职责 | 说明 |
|---|---|
| 加密离线队列 | SQLCipher 加密 SQLite：离线交易、审计暂存、待同步照片。浏览器 IndexedDB 只缓存 UI/字典只读数据 |
| **签名模板本地渲染** | server 打包打印模板（版本 + 签名）→ Edge 验签落盘 → **在线离线一致地本地渲染** ESC/POS/TSPL 字节流。server 侧渲染仅用于 Web 预览。（解决 draft1"服务器渲染 vs 断网打印"矛盾） |
| 打印执行 | 小票/水洗唛/不干胶三族驱动；`print_jobs` 状态回传对账；失败重试 |
| 扫码/钱箱/秤 | 扫码 HID/串口监听；钱箱与打印执行需**授权票据**（下） |
| 号段与回放 | 持有 `ticket_no_blocks`；恢复联网后逐条回放（§11） |

**安全模型（draft3 修订：明确签名方向与密钥职责）**：

- 配对：短期一次性 6 位码（60 秒有效）→ Edge 生成设备密钥对（**私钥仅存本机 OS 凭据区，浏览器永不持有**）→ server 存 pubkey（`edge_devices`）。
- **签名方向三条线**：
  - **Server → Edge：能力票据**——敏感动作（钱箱开启、打印任务）由 server 签发短时票据 `{action, job_id, staff_id, device_id, origin, exp, nonce}`；浏览器仅透传，Edge 验 **server 签名**后执行。
  - **Edge → Server：执行回执**——Edge 用设备私钥签 `{ticket_nonce, result, seq, at}`，server 验签对账（print_jobs / 审计）。
  - **浏览器 → Edge**：携带票据与会话标识；本地通道 `wss://127.0.0.1` + Origin 白名单（仅产品域名）+ 每消息 `{nonce, seq, exp}` 防重放窗口。
- **离线授权分两级（draft3.1）**：
  - **普通 offline grant**：staff×device 短时（默认 12h）授权，含权限版本号与 `offline_allowed` 命令白名单——覆盖开新单、打印等低危离线操作；恢复后 server 以**当前**权限重校验（权限已变 → 进仲裁）。无有效 grant 的终端离线只能打印已渲染任务。
  - **Primary lease（高危租约，与 grant 分离）**：离线**取衣/收款**额外要求设备持有效 lease——签名字段 `{lease_id, store_id, device_id, primary_epoch, issued_at, ttl_ms, max_clock_skew_ms}`；**同店同时至多一个有效 lease 由服务端保证**：新 lease 仅在旧设备**签名 release ACK** 后即时生效，**无 ACK 时须等旧 lease 到期并越过 `max_clock_skew_ms` 容差**才生效（epoch 递增），等待期内新设备只能在线操作。旧 Primary 离线收不到吊销指令无妨——**其权力随 lease 到期自动终结**，这是唯一可靠的离线吊销语义。
  - **签发串行化（diff 复核 P0）**：签发、release ACK、晋升在**同一数据库事务**内完成——先对预创建的 `primary_lease_heads(org_id, store_id)` 行 `SELECT ... FOR UPDATE`，重校验旧 lease 状态，再递增 epoch、插入 `primary_leases`、更新 head，**事务提交后才返回签名 lease**。并发晋升请求在行锁上排队串行，不可能各自签出 lease；`UNIQUE(org_id, store_id, primary_epoch)` 兜底。
  - **可信时间契约（draft3.1a P0，diff 复核精确化公式）**：Edge **禁止用 `Date.now()` 判定 lease 有效性**。截止时间固定为：
    `server_not_after = issued_at + ttl_ms`（`not_after` 一并入签名对象）；
    `local_deadline = request_start_mono + ttl_ms - safety_margin_ms`——**单调钟锚点取发起请求前的时刻，绝不用响应到达时刻**（后者会把网络延迟加到租约尾部）。硬约束：**Edge 本地授权时间恒不晚于服务端 `not_after`**；RTT ≥ TTL 无法满足 → 直接 fail-closed 不启用。发生**进程重启、OS 重启、休眠恢复、时钟异常跳变**且无法证明时间连续性时，**lease 立即失效（fail-closed）**，取衣/收款降级为 online-only，直至重新联网换取新 lease。
  - **epoch/seq 的职责边界（措辞修正）**：每条离线高危命令绑定 `lease_id + primary_epoch + per_lease_seq`，负责**幂等、防重放、顺序与审计归属**——旧 epoch 命令回放时**回执仍写入不可变审计**，但拒绝自动应用领域状态，转人工仲裁。**epoch/seq 不防止物理双交付**（衣物可能已交出）；防物理双交付依赖三件事：**签发串行化、不重叠 lease、可信本地截止**。
- **队列加密密钥职责分离**：SQLCipher 使用**随机生成的 DB DEK**；DEK 由 OS 凭据区（Windows DPAPI / macOS Keychain）中的 KEK 包装——**不从设备签名私钥派生**（签名与加密职责分离）。
- **设备解绑（draft3.1 修正语义）**：**服务端吊销是原子的**——票据/grant/lease 立即失效、设备标记失效、未用号段永久作废、审计落库；**本地擦除是 best-effort**——在线设备即刻执行擦除指令（队列 DEK、照片缓存、模板包）；离线设备收不到指令，其安全性由 grant/lease 短时效兜底，该设备重新联网的第一动作即强制擦除 + 要求重新配对。
- **M0 实测项**：Windows Chrome/Edge 对 `127.0.0.1` WSS 的证书信任方案、Chrome **Local Network Access 权限**行为、防火墙提示——结果决定本地通道最终形态（WSS 证书 vs localhost WS + 消息层加密）。
- Edge 无业务逻辑：所有校验语义仍在 server 命令总线；Edge 只是受约束的执行与暂存端。

## 11. 离线一致性

| 操作 | 断网行为 |
|---|---|
| 开单（散客、现金/记欠款） | ✅ 任何**持有效 offline grant 的配对终端**：号段票号 + 本地价目缓存 + 入 Edge 加密队列 |
| 打印 | ✅ Edge 本地渲染签名模板出票 |
| 取衣 / 收款 | ✅ 仅持有效 **Primary lease** 的终端（防双花，见下）；其余终端离线时禁用 |
| 退款 | ❌ **离线一律禁用**：退款是 R4，step-up 复核必须在线完成（draft3.1） |
| 查历史 | ⚠️ Edge 缓存窗口（最近 N 天）只读 |
| 储值/会员卡支付、办卡充值、设置、AI | ❌ 禁用（org 级共享状态防双花）；UI 明确提示 |
| 纯浏览器（无 Edge） | ❌ 在线-only，仅 UI/字典缓存 |

**Primary lease 裁决（draft3.1，防离线双花）**：每店同时至多一个有效 **Primary lease**；离线状态下**取衣、收款**只允许持 lease 终端执行，其余终端离线仅可开新单（现金/挂账）与打印；**退款离线一律禁用**。理由：两台离线终端同时把同一件衣物交给两位顾客，恢复后的冲突队列**无法追回已交付的实物**——必须在业务规则层杜绝。晋升 = lease 交接：owner 在线授权 → 旧设备**签名 release ACK**，或无 ACK 时等旧 lease 到期**并越过时钟容差** → 新 lease 生效（epoch 递增）；**等待期内新设备只能在线操作**。lease 时长是"故障切换等待"与"离线权力窗口"的权衡（默认 12h，可 per-store 调短），M2 交付。

**恢复流程**：重连 → 员工重新鉴权 → 队列按序回放（幂等键去重）→ server 逐条重校验 **offline grant 权限版本 + 当前 RBAC + 实体版本 + 业务状态**（如该单已在别端被取走 → 冲突仲裁队列）→ 审计补齐 → 同步报告展示给店员。前端常驻连接状态条（在线/离线/N 笔待同步）。

## 12. 数据安全与备份

- PG 每日全量 + WAL 归档（PITR）→ age/GPG 加密 → 对象存储；自托管另落第二介质；保留 30 天滚动 + 12 个月月末。
- **还原演练是功能**：后台一键演练（恢复至影子库 + 校验查询）写 `backups.restored_test_at`；CI 每周自动演练。
- 导出自由：全量 CSV/Excel + 照片打包（高危权限 + 审计）。
- PII：列表手机号默认打码，完整号独立权限位；打印侧"隐藏部分号段"选项；注销/删除流程（个保法）；审计保留期可配。

## 13. 发布、升级与技术支持（draft3 新增）

### 13.1 版本与渠道

- 全线 SemVer；`packages/contracts` 版本是兼容性真源。**兼容单位 = contracts 协议 major**（draft3.1 明确：不兼容变化只能进 major，"上一个产品 release"不是兼容单位）：server 同时支持**当前 major 与上一 major**，废弃期 ≥ 1 个里程碑并通过响应头发 Deprecation 警告；双 major 兼容测试进 CI。
- 渠道（draft3.1 增 LTS）：**beta / stable（SaaS）+ LTS（私有化）**；服务端按 org 分批灰度；每次发布带回滚预案与发布记录。
- **支持矩阵**随每次 release 发布：Server × Web × Edge × contracts major × Edge 本地 schema 五维兼容表——是"能否升级/能否回滚"的唯一判定依据（§13.5 状态机引用它）。

### 13.2 数据库与服务升级

- 迁移一律 **expand → migrate → contract** 三段式：先加列/新表（旧代码兼容）→ 幂等回填任务 → 下一版本才删旧结构；禁止破坏性一步迁移。
- 升级前自动创建备份点；迁移器带 dry-run 与校验查询，失败停在 expand 段可回滚。
- 自托管：`compose pull` 前置检查（只允许逐 minor 升级，禁跳版本）、升级前强制备份、迁移门（校验不过拒绝启动新版本）。

### 13.3 桌面端同步开发与升级

- **桌面为主、Web 次之（draft3.1 用户裁定）**：桌面壳是主要交付形态，纯浏览器为辅助入口（在线-only）；**前期开发以本地 web 服务（单机模式）起步做测试适配**——server + PG 本地 compose，壳与浏览器都连 localhost，同一套代码后续上云。
- **断网冷启动（draft3.1 P0）**：安装包**内置签名的 last-known-good SPA 静态资产**，经自定义 **`app://` 协议**加载本地 UI——断电重启 + 断网也能进入本地离线工作台；在线时同一 UI 调云端 API。"Electron 加载远程 URL"的说法作废。浏览器版与壳**共用 React 代码与 contracts 包，不复制业务代码**；SPA 资产随应用更新并验签。
- **Electron 安全基线**（官方要求，进代码审查清单）：`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webSecurity:true`；preload 最小化（仅暴露白名单 IPC）；IPC 校验 sender；`setWindowOpenHandler` + `will-navigate` 禁任意导航/新窗口/外链；权限请求默认拒绝。
- **每个里程碑含桌面交付物**：M1 配对/签名模板/小票/加密队列骨架；M2 内嵌壳 + 离线闭环 + 扫码 + Primary 晋升；M3 钱箱票据 + 秤；M4 起与服务端同节奏灰度发版。
- 自动更新：签名安装包（Windows 代码签名）、分阶段推送（beta 门店 → 全量）；**失败后按 §13.5 与五维支持矩阵判定：兼容才回原槽；不兼容进入恢复模式并前滚修复**（不存在无条件"自动回滚上一版本"，draft3.1a 修正）；**模板包与应用分离更新**（模板热更新走 §10 签名分发，不必发版）。
- 兼容窗口：server 兼容**当前及上一 contracts major** 的 Edge；低于窗口强制升级提示，**升级前先排空离线队列**。

### 13.4 技术支持体系

- **诊断包**一键导出：脱敏日志 + 版本 + 硬件状态 + 最近错误，店主发给支持渠道。
- **远程协助（draft3.1 收紧）**：店主明示授权 + **重新认证**后才建立，会话中**可实时撤销**；连接一律**从门店出站**（不开入站端口）；支持人员强制 MFA；能力限于**命令级只读白名单**——禁止原始数据库访问、密钥读取、任意 shell；1 小时自动过期、全程审计。
- **支持窗口**：stable ≥ 12 个月；LTS（私有化）≥ 24 个月；安全补丁向后移植到所有受支持版本。**支持期 ≠ 冻结运行时**：Electron 官方仅支持最新三个 stable major——LTS 保持业务功能稳定，但**持续跟进 Electron/Chromium 安全版本**。
- 渠道：工单 + 微信客服；故障分级响应目标（P1 4 小时 / P2 1 个工作日）写入商务条款（细则不属本文件）。
- 产品内"规程与故障排查助手"（R0 AI，M2）作为一线自助支持，降级路径指向人工渠道。

### 13.5 Edge 升级状态机（draft3.1 P0）

autoUpdater 只负责"换二进制"，本地数据兼容由产品自己的升级状态机负责：

- **A/B 双槽程序包**：新版本装入备槽；启动**健康检查**（硬件桥自检 + 本地库可打开 + server 握手）通过才切主槽，失败自动回原槽。
- **升级前置条件**：离线队列已清空回放；升级窗口内**不签发新的 Primary lease**；创建**本地库加密快照**。队列未清空不得安装。
- **Edge 本地库（SQLCipher）同样 expand → migrate → contract**；**离线队列信封独立版本化**（`queue_envelope_version`）；server 保留旧版本队列回放接口，保留期**长于** UI 的双 major 兼容期。
- **回滚判定**：仅当旧版本确认能读取当前本地 schema（contract 段未执行，查 §13.1 支持矩阵）才允许自动回滚；否则进入**恢复模式**（只打印 + 只读）等待前滚修复——**禁止盲目降级**。
- **更新包安全**：包、manifest、hash、回滚目标全部签名；带**最低安全版本**（anti-rollback：低于该版本拒绝安装与回滚）。

## 14. 迁移路径与里程碑（方案 B：AI-first 垂直切片）

**v1 → v2 迁移器**（`tools/migrate-v1`）：v1 SQLite → v2 PG；v1 `order_items`（品类×数量）→ `order_lines` + 按 qty 拆生成 `garments`（补发条码）；customers/photos/settings 直迁；缺失 `expected_pickup_date` 按规则补算。宏发为首个迁移案例；切换窗口双写观察方案在 M1 内出细案。

| 期 | 范围 | AI 切片 |
|---|---|---|
| **V2-M0 技术验证**（短周期 spike） | RLS 性能与负向测试原型（含五类旁路用例）；三类打印机实机协议验证（ESC/POS + TSPL + 水洗唛族）；离线冲突演练（号段+幂等回放+Primary 规则）；**Windows 实测浏览器↔Edge 本地 WSS（证书信任、Chrome Local Network Access 权限、防火墙）**；**Primary lease 时序演练（旧主离线 × 新主等待期 × epoch 交接 × 六类时钟场景：回拨/前跳/进程重启/OS 重启/休眠跨期/旧主失联，lease 必须 fail-closed；并发签发：双 owner 同时晋升、释放与晋升并发；长 RTT/服务端延迟下 local_deadline 恒 ≤ not_after）**；**桌面断网冷启动演练（app:// 本地资产）**；**A/B 槽升级+回滚演练（含本地库快照恢复）**；本地单机模式（dev/test compose）跑通；三 adapter × 代表模型的工具调用兼容矩阵 | 兼容矩阵即 AI 验证 |
| **V2-M1 基座** | identity + **RLS（FORCE + 非 owner 角色 + 租户表矩阵/策略模板冻结 + 三元组合外键进 contracts + CI 负向测试含旁路用例）**；**Command/Query Bus + 风险分级 + 幂等 + Dry-run + 元数据四字段**；审计统一落点（同事务 + 仅 INSERT）；**AI Tool Registry（命令投影）+ Policy Engine v0（确认卡 + R4 同步 step-up 复核）**；Edge Agent v0（配对/签名模板/小票/加密队列骨架）；contracts 冻结流程（含会话/CSRF 契约）；迁移器骨架 | AI 基座即本期主体 |
| **V2-M2 柜台核心 + 只读 AI** | catalog / order（order_lines+garments）/ payment / 取衣（整单+部分）/ 暂存 / 撤销 / 三类打印 / 离线闭环 | 经营问答(R1)、订单/顾客检索(R2 脱敏)、操作助手（只读+导航+草稿）、规程助手(R0)；**BYOK 最小闭环**（加密+verifyKey+官方白名单，1–2 厂商） |
| **V2-M3 会员 + 触达 + 低风险写** | membership 全量、催取工作台、notification + 降级名单、保管费 | 开放 R3：草稿+确认发送、生成催取任务；小批量阈值内单次确认 |
| **V2-M4 账务 + 老板端 + 备份** | accounting 双口径、交班（开关）、老板端 H5、备份+还原演练 | 经营分析深化、对账异常解释、每日/每周经营报告 |
| **V2-M5 AI 完整面** | — | BYOK 全矩阵 + 用量看板 + 限额熔断；自定义网关授权（SSRF 硬化 UI）；**异步审批中心（代办/催办/看板；同步 step-up 自 M1 已可用）**；**有边界定时自动化（automation_policies）**；多模型兼容矩阵进 CI |
| **V2-M6 分四子期** | 6.1 视觉 AI（拍照辅助开单/掉标找衣）；6.2 小程序；6.3 工厂协同（fulfillment 全量+店厂交接）；6.4 取送 + 营销 Flow + 团购核销 | 各子期独立门禁，不合并交付 |

## 15. 多 AI 并行实现分工机制

1. **契约先行**：每期开工前 `packages/contracts`（含命令注册表与风险等级）由 Claude 评审冻结打 tag；期内改契约走 ADR。
2. **目录所有权**：一目录一 AI；跨模块靠契约包；不改他人目录（三 AI 共 checkout 的既有教训：动 git 前探测活跃编辑，审计用独立 worktree）。
3. 可并行切面：`apps/web` / `apps/server` 按 bounded context / `packages/domain`（TDD）/ `apps/miniprogram` / `apps/edge-agent`；Policy Engine 与命令总线属核心基座，单一所有者。
4. **门禁**：TS strict 零错、ESLint 零警、文件 ≤400 行、函数 ≤50 行、嵌套 ≤4、金额零浮点、覆盖 ≥70%、契约测试绿、**跨租户负向测试绿**、**AI 红队用例绿**、Playwright 核心路径绿。Claude 验收，关键节点 Codex 二审。
5. trunk-based 短分支；每模块 PR 带契约测试与种子数据；周五集成日全量 E2E。

## 16. 风险与开放问题

| # | 风险 | 立场 |
|---|---|---|
| 1 | RLS 性能与连接池 GUC 注入复杂度 | M0 实测；策略命中复合索引；慢查询预算进可观测 |
| 2 | Edge Agent 职责扩大后的交付复杂度 | v0 只做 配对/模板/小票/队列骨架，秤与钱箱票据 M2；协议先行冻结 |
| 3 | 命令总线可能被实现方绕过（直调 service） | 架构测试（依赖规则 lint）：apps 层禁 import 领域 service，只许 bus 入口 |
| 4 | 微信资质/聚合运力商务门槛 | 通知先行、支付后置；delivery 先人工叫单记录 |
| 5 | 大陆访问海外模型 | §9.3 三对策，默认大陆厂商 |
| 6 | AI 成本失控 | org 限额熔断 + 默认低价模型 + 用量看板（M5 前靠日志粗算） |
| 7 | 审批中心范围蔓延 | M5 只做 R4 单级审批（owner/指定角色），不做多级流程引擎 |
| 8 | 号段离线极端冲突 | 每设备独立号段 + server 幂等 + 仲裁队列；离线开单仅限配对终端 |
| 9 | PG 对自托管小店偏重 | docker compose 一键装；实测后再评估，不预承诺轻量方案 |
| 10 | Primary Edge 单点（离线高危操作集中一台） | 在线晋升流程（owner 授权 + **旧主在线释放或等待可信 lease 到期越过容差**）M2 交付；Primary 在线时其余终端功能不受限 |
| 11 | 升级兼容窗口执行不严导致断档 | contracts 双 major 兼容测试进 CI；Edge 升级前强制排空队列 + §13.5 状态机（禁盲目降级） |
| 12 | Primary lease 等待期影响故障切换速度（旧主失联需等 lease 到期） | lease 时长 per-store 可调短（默认 12h）；旧设备在线释放则即时交接；等待期新主仍可在线操作 |
