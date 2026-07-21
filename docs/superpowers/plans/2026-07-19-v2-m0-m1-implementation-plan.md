# laundry-v2 实施计划：V2-M0 技术验证 + V2-M1 基座

> 日期：2026-07-19　作者：Claude（设计与门禁）
> 依据：架构 spec draft3.1a（已定稿）、ADR-01…08（全部 Accepted）、UI spec draft3.1a
> 范围：本文件细化 M0 验证与 M1 基座到任务级；当前分工由 ADR-10 与 §3 覆盖。M2–M6 的范围见 ADR-07。
> 角色边界更新：自 2026-07-21 ADR-10 起，未完成项由 Codex 单一负责设计与核心实现，Grok 在冻结接口下协助端侧/平台/硬件；旧四线分工只保留历史事实。

---

## 0. 交付顺序总览

```text
M0 技术验证(spike, 1–2 周) ── 验证六大不确定性,产出证据 ── Claude 门禁: 六项全绿才进 M1
        │
        ▼
M1 基座(3–4 周) ── contracts 冻结 + 命令总线 + RLS + 审计 + Tool Registry + Policy v0 + Edge v0
        │          交付即"AI-first 骨架": 之后每个业务模块注册命令即自动获得 AI 工具
        ▼
M2… 柜台核心 + 只读 AI（另计划）
```

**桌面为主**（用户裁定）：M0/M1 的所有验证与交付都以"桌面壳 + 本地单机模式"为主路径，纯浏览器为辅。前期起本地 web 服务（`docker compose`：server + PG）做测试适配。

---

## 1. V2-M0 技术验证（spike）

目的：把架构里六处"设计假设"变成"实测证据"，任何一处不成立就在写生产代码前调整设计（走新增 ADR）。M0 **只产出验证代码与报告，不产出生产代码**。

### 1.1 验证矩阵（六项，每项含通过标准）

| #    | 验证项                                | 步骤                                                                                                                                                                          | 通过标准（门禁）                                                                                                         | 主责   |
| ---- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| M0-1 | **RLS 三元租户隔离 + 性能**           | 建 orders/order_lines/garments 最小三表（三元组合外键）+ FORCE RLS + 非 owner 角色；写五类旁路负向用例（GUC 未设置/空值/回滚残留/连接池串租户/worker 漏注入）；灌 10 万单造压 | 五类旁路**全部查不到跨租户行**（未设 GUC 时 0 行而非报错放行）；带 `org_id` 复合索引下单店常用查询 P95 < 50ms            | Codex  |
| M0-2 | **Primary lease 时序 + 可信时间**     | 实现 head 行 `SELECT FOR UPDATE` 签发 + 签名 lease + 单调钟本地截止；脚本模拟六类时钟场景 + 双 owner 并发晋升 + 释放/晋升并发 + 长 RTT                                        | 时钟回拨的旧主命令被 epoch 拒收；无 ACK 时新 lease 必等旧到期+容差；并发晋升不产生两个有效 lease；RTT≥TTL 时 fail-closed | Codex  |
| M0-3 | **三类打印机实机**                    | 用宏发现役三台（XP-58 小票 / DASCOM DL-206 水洗唛 / Gprinter GP-3120 不干胶）跑 ESC/POS + TSPL 字节流；验证水洗唛切刀、变量渲染                                               | 三台各出一张正确样张；模板变量（21/22 个）渲染无误                                                                       | Grok   |
| M0-4 | **Edge 本地通道 + 冷启动 + A/B 升级** | Windows 实测浏览器↔`127.0.0.1` WSS（证书信任/Chrome LNA 权限/防火墙）；`app://` 内置 SPA 断电冷启动；A/B 双槽升级+本地库快照回滚                                              | 断网重启能进本地工作台；WSS 通道方案确定（证书 vs 消息层加密）；回滚判定按支持矩阵正确执行                               | Grok   |
| M0-5 | **三 adapter × 模型工具调用兼容矩阵** | anthropic / openai-compat / gemini 三 adapter 各接 1–2 代表模型，跑同一个 tool-use 循环（含并行工具、流式、JSON 解析）                                                        | 每 adapter 至少一款模型稳定完成"查询→工具→回填→结束"闭环；方言差异记录成表                                               | Gemini |
| M0-6 | **本地单机模式跑通**                  | `docker compose`：server + PG + （mock）Edge；壳与浏览器都连 localhost；跑一条 假开单→打印(mock)→取衣                                                                         | compose 一键起；冒烟路径绿；为后续所有开发提供统一本地环境                                                               | Gemini |

### 1.2 M0 产出物

- `tools/spikes/` 下六个独立验证目录 + 各自 README（步骤可复现）。
- `docs/research/2026-07-19-v2-m0-findings.md`：逐项结论（通过/不通过/需改设计）。
- 若任一项证明设计需改 → Claude 起草新增 ADR，评审后再进 M1。

### 1.3 M0 门禁（Claude 验收）

六项全绿 + findings 报告完整 + 无阻塞性设计变更悬空。任一项红灯则 M1 相关部分暂缓。

---

## 2. V2-M1 基座

目的：搭出"AI-first 骨架"——统一命令总线 + Tool Registry + RLS + 审计 + Policy v0 + Edge v0 + 冻结契约。此后每个业务模块只要注册命令/查询，人工 UI 与 AI 工具同时获得，不写第二套逻辑。

### 2.1 工作分解（按目录所有权切分，见 §3 分工）

#### 包 A · `packages/contracts`（契约先行，最先冻结）— **Codex**

- [ ] A1 命令/查询注册表 schema：`{name, version, input:Zod, risk:R0–R5, invariants, idempotent, sideEffects, offline_allowed, data_classification, max_batch, result_redaction}`
- [ ] A2 统一信封 `{ ok, data } | { ok, error }` + 错误码表
- [ ] A3 租户表矩阵（org 级/店级/全局字典三类）+ 三元组合键约定 + RLS USING/WITH CHECK 模板
- [ ] A4 Edge 桥协议（能力票据 / 执行回执 / offline grant / Primary lease 签名对象 / 队列信封版本）
- [ ] A5 Web 会话/CSRF 契约（access/refresh/PIN/双提交头）
- [ ] A6 M1 首批命令定义（identity 域：登录、PIN 切换、建店建员；platform 域：设置读写、审计查询）
- [ ] A7 `zod-to-openapi` 生成 OpenAPI 3.1 + 前端类型生成脚本
- **冻结门禁**：Codex 逐组提交可复现评审证据；A1—A7 全组通过后由 manpengan 确认并打 tag `contracts@v0.1.0`；此后改契约走 ADR。

#### 包 B · `packages/domain`（纯函数 + TDD）— **Codex**

- [ ] B1 金额工具（整数分、格式化、禁浮点）+ 单测
- [ ] B2 命令信封校验链骨架（Zod→RBAC→租户→Policy→不变量 的纯逻辑部分，IO 由 server 注入）
- [ ] B3 order/garment 状态机转移表（含 delivered/reworked/lost、fulfillment 关闭坍缩）+ 穷举单测
- [ ] B4 风险分级判定（R0–R5 + 参数阈值升级 R3→R4）纯函数
- **门禁**：覆盖率 100%（纯函数无理由低于）。

#### 包 C · `apps/server`（Fastify + 命令总线）— **Codex**

- [ ] C1 命令总线运行时：注册表加载、校验链装配、事务执行（业务+审计同事务）、领域事件
- [ ] C2 RLS 接入：连接池事务级 `SET LOCAL` GUC 注入（含 worker）；`laundry_app` 非 owner 角色
- [ ] C3 审计统一落点（同事务 + 仅 INSERT 权限 + RLS）
- [ ] C4 AI Tool Registry：命令注册表的只读投影（附 LLM 描述 + 脱敏规则）
- [ ] C5 Policy Engine v0：R0–R5 判定 + 确认卡（`ai_pending_actions`：canonical args 冻结 + args_hash + 实体版本 + nonce + 有效期）+ R4 同步 step-up（不可自核、原子单次消费）
- [ ] C6 identity 服务：argon2id、JWT+refresh 轮换、CSRF、PIN 快切、RBAC（约 40 权限点 + 高危组）
- [ ] C7 platform 服务：设置、feature flags、审计查询
- [ ] C8 鉴权中间件：actor/tenant 只从服务端会话注入（拒绝客户端/LLM/Edge 自报）
- **门禁**：跨租户负向测试绿；AI 红队用例绿（注入样本不产生未授权工具调用）；审计覆盖 100% 写操作。

#### 包 D · `apps/edge-agent`（Edge v0）— **Codex（安全核心）+ Grok（platform adapters/实机）**

- [ ] D1 Electron 壳：`app://` 内置签名 SPA、断网冷启动、Electron 安全基线（contextIsolation/sandbox/webSecurity/最小 preload）
- [ ] D2 配对（60s 一次性码 + 设备密钥对，私钥入 OS 凭据区）+ 能力票据验签 + 执行回执签名
- [ ] D3 SQLCipher 加密队列（随机 DEK + OS 凭据区 KEK 包装）骨架
- [ ] D4 签名打印模板本地渲染 + 小票（XP-58 ESC/POS）打印执行 + `print_jobs` 回执
- [ ] D5 A/B 双槽 + 健康检查 + 升级前快照 + 回滚判定骨架（完整状态机 M2 补）
- **门禁**：M0-4 结论落地；Windows 实机冷启动 + 小票打印通。

#### 包 E · `apps/web`（登录 + 骨架）— **Grok 协助（Codex 冻结 API/授权语义）**

- [ ] E1 登录页 + PIN 快切 + 连接状态条骨架
- [ ] E2 设计系统 tokens 迁入 `packages/ui`（液态玻璃）+ 基础组件（Button/Input/Table/Drawer/MoneyText/StatusBadge）
- [ ] E3 权限门控路由骨架（按 role × feature flag 出 IA）

#### 包 F · `tools/`（迁移器骨架 + 种子 + compose）— **Codex**

- [ ] F1 `tools/migrate-v1` 骨架：v1 SQLite → v2 PG 映射表（order_items→order_lines+garments 拆件补条码），M1 只做只读试跑
- [ ] F2 种子数据（一个 org/store/管理员 + 价目字典），供各包本地开发
- [ ] F3 `docker compose`（server+PG）单机模式（承接 M0-6）

### 2.2 M1 集成门禁（Codex 组织证据 + manpengan 放行）

- TS strict 零错、ESLint 零警、文件 ≤400 行、函数 ≤50 行、嵌套 ≤4、金额零浮点
- 覆盖率 ≥70%（domain 100%）
- **契约测试绿**（OpenAPI 快照）
- **跨租户负向测试绿**（五类旁路）
- **AI 红队用例绿**（prompt injection 不产生未授权工具调用）
- **确认卡 WYSIWYS 断言绿**（参数变更旧卡作废、过期不可执行、canonical 冻结）
- Playwright 核心路径绿（登录→PIN 切换→改一条设置→审计可见）
- 关键节点（命令总线 + Policy Engine + RLS + Edge crypto）过 Codex 二审

---

## 3. 当前交付机制（ADR-10）

- **Codex**：设计、contracts、domain、server、PG/migrations、迁移、Edge 安全核心、集成和门禁。
- **Grok**：在冻结 ports/contracts 下实现 Web/UI、Edge platform/drivers/packaging、Windows/打印机实测与黑盒测试。
- **Claude/Gemini**：退出关键路径；历史资产保留，未合分支只作候选输入。
- **合并**：Codex 提交合并建议，manpengan 执行，Codex 验证 main。

```text
A3/A5/A6/A7 + B2/B4
        ↓
PG/RLS(C2) → Command Bus(C1) + Audit(C3)
        ↓
Identity(C6/C8) → Policy(C5) → Tool Registry(C4) → Platform(C7)
        ├─→ Grok: E1/E3（A5/A6/A7 后实现，C6/C8 后验收）
        └─→ Grok: Edge platform adapters（Codex core ports 后）
```

详细边界和阶段见 [2026-07-21 交付治理](../specs/2026-07-21-laundry-v2-delivery-governance.md)。

---

## 4. 里程碑之后（M2–M6 提要）

> **已展开为同粒度计划**：[V2-M2 → V2-M6 实施计划](2026-07-19-v2-m2-m6-implementation-plan.md)（2026-07-19）。下表保留作索引。

| 期       | 一句话范围                                                           | 当前主责                  |
| -------- | -------------------------------------------------------------------- | ------------------------- |
| M2       | 柜台核心（件级开单/取衣/三类打印/离线闭环）+ 只读 AI + BYOK 最小闭环 | Codex；Grok 端侧/实机协助 |
| M3       | 会员储值 + 通知/催取 + 开放 R3 写                                    | Codex；Grok UI 协助       |
| M4       | 账务双口径 + 交班 + 老板端 + 备份还原 + 分析类 AI                    | Codex；Grok UI 协助       |
| M5       | BYOK 全矩阵 + 异步审批中心 + 有边界自动化                            | Codex；Grok UI/黑盒协助   |
| M6.1–6.4 | 视觉 AI / 小程序 / 工厂协同 / 取送营销（四子期独立门禁）             | Codex；Grok 端侧协助      |

每期开工前，Codex 提交本期同粒度计划与 contracts 增量；manpengan 确认放行。

---

## 5. 当前下一步（2026-07-21）

1. manpengan 合入全绿 PR #54；Codex 验证 main 同提交两条 CI。
2. 合入 ADR-10、治理 spec、当前任务书和接管计划。
3. 依次完成 A3/A5/A6/A7 与 B2/B4；A1—A7 全组通过且 ADR-09 签署后再建议创建 `contracts@v0.1.0`。
4. 按 PG/RLS→Command Bus/Audit→Identity/Policy 的纵向链收口 M1。
