# laundry-desk v2 单一技术负责人交付治理

> 日期：2026-07-21
> 状态：Approved（manpengan 选择方案 A）
> 适用范围：V2-M1 未完成项及 V2-M2—M6 后续设计、实现与验收
> 覆盖关系：本文件覆盖架构 spec §15、M0/M1 计划 §3、M2—M6 计划 §6 以及 2026-07-19 四 AI 任务书中尚未完成的职责分配；历史事实和已合入成果不改写。

## 1. 决策

自本文件生效起：

1. **Codex 是单一技术负责人**，负责后续设计真源、ADR、契约、核心实现、安全边界、集成顺序、测试门禁和交付证据。
2. **Grok 是受约束的协助实现线**，只在 Codex 冻结的接口与验收条件下承担端侧、平台适配、硬件实测、UI 与黑盒测试。
3. Claude 与 Gemini **退出实现与冻结关键路径**；其已合入成果继续有效，未合并分支和文档草稿只作为候选输入。两者可提供非阻塞复审，但无等待依赖、冻结权或合并前置权。
4. manpengan 保留产品裁决与外部凭据/硬件协调权；自 2026-07-21 的补充书面授权起，Codex 可在 required checks 与验收门禁满足后执行 PR 合并，并必须复核合入后 main。

本决策解决的问题不是“换名字”，而是移除多 AI 目录锁、契约等待和交叉验收形成的循环依赖，让一条纵向链对设计、代码与证据同时负责。

## 2. 事实基线

盘点基线为 `origin/main@65e4031`（PR #53 合入 A4 后）；P0 已在 `origin/main@9da3c5f` 合入 PR #54 并确认同提交两条 workflow 成功。状态只按 main、PR、CI 和可复现实跑判定，不以任务书、代理报告或远端分支代替。

| 分类           | 当前内容                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 已合入并可复用 | A1 注册表、A2 信封/错误、A4 Edge 协议、B1 金额工具、B3 状态机、E2 UI 基础库、D1 Electron 壳骨架、D5 升级状态机骨架、F2 seed、F3 mock compose |
| 部分实现       | D1 缺签名 SPA 与 Windows 证据；D5 缺 updater I/O、真实快照与原子槽切换；F3 仍使用 mock server                                                |
| 未实现         | A3/A5/A6/A7、B2/B4、C1—C6/C8、F1、D2/D3、E1/E3                                                                                               |
| 仅候选输入     | `origin/feat/m1-c7-platform` 的内存 C7 原型；`origin/claude/m1-gates` 的 A6 未发布草稿                                                       |
| 仅 spike/mock  | M0-1/M0-2 生产转正前底稿、D4 打印 mock、M0-5 模型 mock、M0-3/M0-4 无实机部分                                                                 |
| 治理缺口       | 无 `contracts@v0.1.0` tag；ADR-09 仍为 Proposed；A4 验收索引落后；正式 v2 PG schema/migrations 不存在                                        |
| 基线恢复       | PR #54 已合入 `9da3c5f`；main 的 V2 Foundation 与 Build/Release 在该提交成功                                                                 |

任何后续状态更新必须继续区分“已设计、已编码、已开 PR、已合 main、CI 绿、实机通过”六种状态。

## 3. 责任边界

### 3.1 Codex 主责

Codex 对以下内容拥有设计与实现责任：

- 架构 spec、ADR、contracts 版本和里程碑实施计划；
- `packages/contracts`、`packages/domain`；
- `apps/server` 全部服务端能力；
- v2 PostgreSQL schema、版本化 migrations、RLS、角色与事务封装；
- Command Bus、审计、Tool Registry、Policy、确认卡、step-up；
- identity、session、CSRF、PIN、RBAC 与 actor/tenant 服务端注入；
- Edge 密码学与协议语义：配对、签名、DEK/KEK、SQLCipher、lease、回放水位；
- 打印模板、job/receipt、升级 manifest 与 anti-rollback 的服务端/协议不变量；
- `tools/migrate-v1`、seed/compose 的正式 schema 集成；
- 架构依赖 lint、跨租户、审计回滚、WYSIWYS、AI 红队及集成门禁；
- 对 Grok 交付的接口验收与安全复审。

### 3.2 Grok 协助

Grok 只在已冻结接口下承担：

- `apps/web` 页面、交互、响应式、可访问性、视觉回归与 Playwright E2E；
- `packages/ui` 组件扩展和主题实现；
- `apps/edge-agent` 的 Windows/macOS 平台 I/O、OS 凭据区适配、打包、autoUpdater 接线和故障演练；
- XP-58、DL-206、GP-3120 字节 adapter、驱动适配和实机证据；
- 端到端黑盒、故障注入、跨平台和硬件回归测试；
- 按 Codex 提供的 schema、ports 和 fixture 完成消费侧适配。

Grok 不得自行改变：

- contracts 公共形状和 canonicalization；
- 密钥生成、派生、包装、签名范围和 nonce/seq 语义；
- actor/tenant 来源、RLS 策略、审计权限；
- lease、离线授权、回放仲裁；
- Policy 风险、确认卡、不可自核和审批语义。

若端侧发现接口不可实现，先提交可复现证据和变更请求，由 Codex 更新 ADR/contracts 后再继续。

为避免再次出现同目录并行冲突，Edge 采用 ports/adapters 文件边界：

- Codex 拥有 `apps/edge-agent/src/core/`、`security/`、`queue/`、`lease/` 的协议状态机与安全核心；
- Grok 拥有 `apps/edge-agent/src/platform/`、`drivers/`、`packaging/` 的 OS/硬件适配；
- 公共 port 类型由 Codex 放入 `packages/contracts` 或 Edge `core/ports`，Grok 只实现 port；
- `apps/web` 与 `packages/ui` 由 Grok 负责实现，API client 只能消费 A7 生成物，不手写第二套请求类型。

### 3.3 Claude/Gemini 既有资产

- 已进入 main 的代码与门禁结论按正常代码维护，不因负责人变化而推倒重做。
- 未进入 main 的分支不得直接合并；先提取测试意图和需求，再按当前架构重写或择取。
- 可选复审不得阻塞 PR；复审意见由 Codex 判断是否纳入，架构争议由 manpengan 仲裁。

## 4. 真源与变更纪律

优先级从高到低：

1. manpengan 的书面裁决；
2. Accepted ADR 与本治理文件；
3. 当前架构 spec；
4. 当前里程碑实施计划和任务书；
5. contracts 代码与版本 tag；
6. PR 描述、验收单、代理报告。

冲突处理：

- 已 Accepted ADR 不回改正文；新决策写新增 ADR。
- spec 与任务书必须在同一治理 PR 内同步，禁止产生两个当前真源。
- contracts 每组可独立冻结并解闸；A1—A7 全部通过后才打最终 `contracts@v0.1.0` tag。
- 任何公共契约变更必须同时带消费侧编译/快照测试。

## 5. 接管顺序

### P0：恢复可信基线与治理

1. Codex 已复核并合入 PR #54，确认 main 的 Build/Release 与 V2 Foundation 在 `9da3c5f` 同一提交全绿。
2. 合入本治理变更，更新角色入口、任务书、验收索引和状态文档。
3. 请求并记录 ADR-09 的独立签署，修正 A4 冻结记录；ADR-09 未签署前不得创建最终 contracts tag。

### P1：闭合 M1 契约与纯函数

按独立 PR 推进：

1. A3 租户矩阵、三元键和 RLS 模板：从 M0-1 提取候选设计，冻结 contracts 层的表分类、组合键和 SQL 模板；此阶段只完成契约冻结，不宣称生产 RLS 已转正；
2. A5 session/refresh/CSRF/PIN 契约；
3. A6 identity/platform 首批命令，刷新旧草稿后重新评审；
4. A7 OpenAPI 3.1 生成、快照和前端类型；
5. B2 校验链 ports/纯函数；
6. B4 风险与阈值升级纯函数；
7. 全组通过后打 `contracts@v0.1.0`。

### P2：生产 PG 与服务端纵向链

1. 建立与 v1 SQLite 隔离的 v2 PG schema/config/migrations，并把 A3 模板转成正式 migration；生产转正状态留待 P4 的角色与五类旁路门禁通过后确认；
2. C2 事务边界、`SET LOCAL`、应用/owner 角色和 worker 注入；
3. C1 Command Bus 与 C3 同事务审计；
4. C6 identity 与 C8 服务端认证上下文；
5. C5 Policy、确认卡和 step-up；
6. C4 Tool Registry；
7. C7 platform 按 repository + bus 重写；旧内存分支只保留测试意图。

### P3：Grok 并行协助线

- A4 已冻结后：D2/D3 的平台适配与黑盒测试，协议与安全核心由 Codex先提供；
- A5/A6/A7 冻结后：Grok 实现 E1 登录/PIN 与 E3 权限路由；其黑盒验收等待 C6/C8 可运行服务；
- D1：Codex 冻结 SPA manifest 信任模型、签名/证书固定和 IPC schema；Grok 完成平台接线、打包与 Windows 冷启动证据；
- D4：Codex 冻结签名模板、验签、job/receipt schema 与不变量；Grok 实现驱动/渲染和实机适配，三台实机均通过才算完成；
- D5：autoUpdater、槽/快照 I/O 与恢复演练，状态机语义不改。

### P4：M1 集成收口

1. compose 用真实 `apps/server` 替换 mock cloud server；
2. seed 对正式 schema 可执行并进入 CI；
3. F1 只读迁移试跑，金额/件数/客户数三项零丢失；
4. 架构依赖 lint、五类 RLS 旁路、审计回滚、WYSIWYS、AI 红队、OpenAPI 快照和登录 E2E 全绿；
5. identity 负向门禁全绿：PIN 暴力破解限速/锁定、refresh rotation 与 reuse 检测、会话撤销与固定攻击拒绝、CSRF 跨源拒绝、step-up 过期与不可自核；
6. M1 门禁通过后才开始 M2 柜台业务。

## 6. PR 与工作树规则

- 每项使用独立 `codex/*` 或 `grok/*` 短分支和独立 worktree；禁止在主 checkout 编辑。
- 一个 PR 只交付一个冻结组或一个纵向能力；依赖 PR 用 stacked 顺序，不把多项攒成大包。
- 所有依赖变更同步 `package-lock.json` 与 `pnpm-lock.yaml`。
- PR 必须写清基线提交、真实执行命令、结果和未覆盖环境；mock/降级证据必须显式标识。
- Codex 可以提交、维护并在 required checks 与对应验收通过后合并 PR；不得使用管理员绕过或跳过 main 复核。
- PR 合入不等于门禁完成；合入后验证 main 同提交 CI，硬件/Windows/真实模型另记实跑状态。

## 7. 完成定义

一项任务只有同时满足以下条件才可标记完成：

1. 代码和文档进入 main；
2. 对应 CI 在 main 的同一提交成功；
3. 任务书验收断言全部可失败且已实跑；
4. 生产边界没有被 mock、内存仓储或 spike 替代；
5. 所需 Windows、打印机、真实模型或迁移数据证据已完成；若外部条件未满足，状态只能是“代码侧通过/待实测”。

## 8. 方案取舍

未选择的方案：

- **仅重命名旧四线分工**：文档改动少，但保留契约等待、跨目录锁和双重验收，不解决根因。
- **从头重做 M1**：真源最干净，但会浪费 A1/A2/A4、B1/B3、E2 和 Edge 骨架的有效资产。

方案 A 在保留已验证资产的同时，把所有尚未完成的关键路径收敛到单一负责人，返工和协调成本最低。
