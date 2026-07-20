# V2-M1 开工提示词（四份，manpengan 下发用）

> 日期：2026-07-20　起草：Claude（设计与门禁）
> 前置：M0 已收口（五项通过，M0-5 待真实 key），main 双 CI 线全绿，PR 队列清空。
> 用法：各 AI 独立会话，整段粘贴。**先发 Claude + Codex**（契约冻结是全队发令枪），
> Gemini/Grok 可同时开工其不依赖契约的部分。

---

## 给 Claude（设计与门禁）

```text
M0 已收口：M0-1/2/3/4/6 通过，M0-5 代码侧通过但待真实 API key（不阻塞 M1）。
main 双 CI 线（Build/Release + V2 Foundation）全绿，PR 队列清空。
你的任务书：docs/superpowers/plans/tasks/2026-07-19-task-claude.md（§3 M1 阶段）

本阶段你的主线是 T4：与 Codex 结对冻结 contracts@v0.1.0。这是全队发令枪。

执行方式（重要——不要等 Codex 全做完再一次性评审）：
Codex 每完成一组就评审一组，逐组过。七组顺序：
  A1 命令/查询注册表 schema（含 risk R0–R5、idempotent、offline_allowed、
     data_classification、max_batch、result_redaction 六字段）
  A2 统一信封 {ok,data}|{ok,error} + 错误码表
  A3 租户表矩阵 + 三元组合键约定 + RLS USING/WITH CHECK 模板（SQL 常量）
     ← 直接采信 M0-1 实测底稿，不要重新设计
  A4 Edge 桥协议类型（能力票据/执行回执/offline grant/Primary lease/队列信封版本）
     ← 直接采信 M0-2 的签名 lease 对象结构
  A5 会话/CSRF 契约
  A6 M1 首批命令定义（identity / platform 域）
  A7 zod-to-openapi 生成 + OpenAPI 快照进契约测试

评审时逐条对照架构 spec 与已 Accepted 的 ADR-01…08；发现 spec 本身有歧义
→ 起草新增 ADR 澄清，不回改已 Accepted 正文。全部通过后打 tag contracts@v0.1.0
并通知全队。

同时进行 T5 门禁资产（可与 T4 并行，交对应 AI 执行、你验收）：
  - AI 红队用例集 ≥20 条（备注藏指令 / 图片藏文字 / 工具参数越权 /
    跨租户诱导 / R5 诱导），断言「不产生未授权工具调用」
  - 跨租户五类旁路负向用例规格 → 由 M0-1 转正为 CI 门禁
  - 确认卡 WYSIWYS E2E 断言规格（换参作废 / 过期不可执行 / canonical 冻结 /
    step-up 不可自核）
  - 每包 PR 验收 checklist 模板（含 Electron 安全基线自查表）

M1 期间持续职责：T6 逐 PR 验收、T7 每周五集成门禁、docs/CHANGELOG.md 自本期建立。

三条本期必须盯住的（M0 实测教训，写进你的验收 checklist）：
1. 证据强度 ≥ 结论强度——无实测证据不得写「通过」
2. 提交前 rebase——M0 期间有人在过时工作树提交，覆盖了 main 已有修复
3. 断言必须能失败——`|| echo PASS` 式写法一律打回
4. 【新增】增删依赖必须同时更新 package-lock.json 与 pnpm-lock.yaml，
   否则两条 CI 线必有一条红（本轮 #38 已踩）

先做 T4 第一组（A1）的评审准备，等 Codex 提交。
```

---

## 给 Codex（安全与基座，本期任务最重）

```text
M0 已收口，M1 全线放行。你的 M0-1/M0-2 零返工通过，实测数据已成为契约底稿。
你的任务书：docs/superpowers/plans/tasks/2026-07-19-task-codex.md
（注意 §3 新增了一节「C 包·安全与身份」——manpengan 按 M0 表现重配分工，
 原属 Gemini 的四项已移交给你。你本期共 14 项，是全队最重的一条线。）

开工顺序（严格按此，前面是后面的前置）：

【第一优先：A1–A7 契约落地】——全队发令枪，其他两家等你
  逐组提交给 Claude 评审，不要攒到最后一次性交。
  A3 租户矩阵与 RLS 模板：直接把你 M0-1 的 DDL 与策略模板转正，别重新设计。
  A4 Edge 桥协议：直接采信你 M0-2 的签名 lease 对象结构
     {lease_id, store_id, device_id, primary_epoch, issued_at, ttl_ms,
      max_clock_skew_ms, not_after, sig}。
  A1 命令元数据六字段务必齐全：risk(R0–R5)、idempotent、offline_allowed、
     data_classification、max_batch、result_redaction。
  全部通过后 Claude 打 tag contracts@v0.1.0。

【第二：C1–C5 基座】
  C1 命令总线：校验链固定顺序 Zod→RBAC→租户→Policy→不变量→事务执行→领域事件；
     业务变更与审计写入**同一事务**，审计失败整体回滚。
  C2 RLS 接入：连接池事务级 SET LOCAL（含队列 worker 同一注入）；
     laundry_app 连接、迁移走 owner。M0-1 的五类旁路用例转正为 CI 门禁。
     ⚠️ M0-6 复验发现：owner 若无策略覆盖会被 FORCE RLS 全量拒绝，
     导致迁移/回填/seed 全部失败。init.sql 已补 maintenance_policy，
     生产 schema 必须带上同类策略。
  C3 审计：总线末端统一落点；audit_log 对应用角色仅授 INSERT；审计表启用 RLS。
  C4 AI Tool Registry：命令注册表的**只读投影**（LLM 描述 + 脱敏规则 +
     per-preset 白名单）。R5 不投影。M1 阶段不发真实模型请求，
     故不受 M0-5 待实测影响。
  C5 Policy Engine v0：R0–R5 判定 + 参数阈值升级（R3→R4）；
     确认卡 ai_pending_actions（canonical args 服务端冻结、args_hash、
     实体版本、nonce、5 分钟有效期、幂等键，确认只提交 nonce）；
     R4 同步 step-up（具备审批权限者现场 PIN/扫码、不可自核、原子单次消费）。

【第三：新接手的四项】
  B4 风险分级判定（纯函数放 packages/domain，与 C5 耦合故归你）
  C6 identity：argon2id（说明参数选型依据）、JWT access(15min 仅内存)/
     refresh(14d httpOnly+SameSite 轮换)、CSRF 双提交、柜台 PIN 快切、
     RBAC ~40 权限点（高危独立组）
  C8 鉴权中间件：actor/tenant **只从服务端认证会话注入**，拒绝客户端/LLM/Edge
     自报的 org/store。你 M0-1 的五类旁路用例可直接复用为回归。
  F1 tools/migrate-v1：v1 SQLite → v2 PG（order_items 按 qty 拆
     order_lines+garments 并补发条码；缺失 expected_pickup_date 按规则补算）。
     M1 只做**只读试跑 + 差异报告**，不写宏发真实库——件级拆分是 v1→v2
     最大不可逆点。差异报告须做到金额/件数/客户数三项零丢失。

【验收】架构测试（依赖规则 lint）证明 apps 层无法绕过总线直调 service；
确认卡 WYSIWYS 断言绿；Claude 提供的 AI 红队用例全绿；跨租户负向测试绿。
C6/C8/F1 因你本就是二审方，不再需他人二审，但必须附实跑证据。

【二审职责继续】Gemini 的 C7、Grok 的 D2/D3 需你二审。

【环境提醒】
- 本地 PG 可继续用你 M0-1 自带 compose；M0-6 已复验通过，
  Gemini 转正 tools/compose/ 后全队统一切换。
- 增删依赖必须同时更新 package-lock.json 与 pnpm-lock.yaml。

先做 A1，交 Claude 评审后再往下。
```

---

## 给 Gemini（领域实现，本期减量降难）

```text
M0 已收口。你的 M0-5 代码侧已通过（证据诚信问题已消除、strict tsc 0 错、
三 adapter JSON 校验闭环），仅差真实模型调用证据——manpengan 会以环境变量
提供 API key，届时补跑即可转「通过」。M0-6 已判通过。

你的任务书：docs/superpowers/plans/tasks/2026-07-19-task-gemini.md
【重要】manpengan 已按 M0 表现重配分工：你本期从 10 项减至 **5 项**，
原属你的 C6 identity、C8 鉴权中间件、F1 迁移器、B4 风险分级已移交 Codex。
留给你的都是规则明确、可被穷举单测完全覆盖的工作。

本期五项：

【可立即开工，只依赖类型不依赖契约冻结】
  B1 金额工具（packages/domain，覆盖率 100%）
     整数分、格式化、分摊/取整规则。任何浮点出现即测试失败。
     参考：Grok 在 M0-3 已实现 lib/money.ts（fenToYuanText + 全角 ￥），
     可直接借鉴其思路，注意半角 ¥(U+00A5) 在 GBK 无映射的坑。
  B3 order/garment 状态机（packages/domain，覆盖率 100%）
     显式转移表：received→washing→ready→racked→picked_up|delivered；
     reworked 回环；lost 高危终态；fulfillment 关闭时坍缩为
     received→picked_up|delivered。
     **穷举单测**：所有非法转移必须全被拒绝——这是本项的核心价值。

【等 contracts@v0.1.0 冻结后】
  C7 platform：settings、store_features flags、审计查询（只读）
     ——过 Codex 二审

【工具链】
  F2 种子数据：1 org / 1 store / 管理员+店员 / 价目字典
     （参考顺科 11 服务大类 × 品类；手机号一律用 13800000xxx 虚构段）
  F3 compose 转正：把 tools/spikes/m0-6-compose/ 转为 tools/compose/
     ——门禁已复验通过，可以转正了。转正后通知全队切换。
     注意保留门禁修的三处：BuildKit 不再硬禁用、Test 4 用 laundry_app +
     正确 GUC 且断言校验错误类型、init.sql 的 owner maintenance_policy
     与三条策略的显式 WITH CHECK。

【本期三条工作要求——每条都对应你 M0 的实际判负原因，请务必遵守】
1. **证据即结论**：findings/PR 描述里的结论不得超出证据强度。
   没有实测就写「待实测」，不要写「通过」。
2. **提交前先 rebase**：git fetch origin && git rebase origin/main。
   M0 期间你在过时工作树上提交，覆盖了 main 已有的 CI 修复
   （build/ 打包资产、workflow rebuild:node、e2e 断言三处回退）。
3. **断言必须能失败**：`|| echo "PASS"` 对任何非零退出都通过＝永不失败
   （M0-6 Test 4 判负原因）。写完测试先人为破坏一次，确认它真会红。

【新增第 4 条】增删依赖时必须同时更新 package-lock.json 与 pnpm-lock.yaml。
本轮 #38 因只更新 npm 锁导致 workspace-check 报 ERR_PNPM_OUTDATED_LOCKFILE；
另外装依赖前先查 peer 兼容性——openai@4 要求 zod@3 与主项目 zod@4 冲突，
已由门禁升到 openai@6 解决。

B1/B3 现在就能开工，不必等契约。
```

---

## 给 Grok（端与硬件）

```text
M0 已收口。你的 M0-4 判**通过**，M0-3 判**通过（降级）**——￥ 的 GBK 问题
你抽出 lib/money.ts 统一处理并加 4 条 0x3F 防回归，门禁实跑 17/17 绿，
比原建议的「7 处字符替换」更好。剩余只是 Windows 实机演练，等 manpengan 排期。

你的任务书：docs/superpowers/plans/tasks/2026-07-19-task-grok.md（§3 M1）
入口守则：GROK.md

本期任务：

【可立即开工，不依赖契约冻结】
  E2 设计系统（packages/ui）
     v1 液态玻璃 tokens 迁入；基础组件 Button/Input/Table/Drawer/Dialog/Toast；
     MoneyText（全局唯一金额渲染，分→元，禁止别处手写格式化）；
     StatusBadge（色+形双编码，色盲安全）。
     注意：Codex 的 monorepo 基座已合入 main，packages/ui 空壳已就位。

【等 contracts@v0.1.0 冻结后】
  D1 Electron 壳：app:// 内置签名 SPA、断网冷启动、安全基线硬性达标
     （nodeIntegration:false、contextIsolation:true、sandbox:true、
      webSecurity:true、最小 preload + sender 校验、禁任意导航/新窗口/外链、
      权限默认拒绝）——你 M0-4 已逐项验证过，直接转正
  D2 配对与签名：60s 一次性码、设备密钥对（私钥仅入 OS 凭据区，
     浏览器永不持有）、验 server 能力票据、签执行回执 ——过 Codex 二审
  D3 SQLCipher 加密队列骨架：随机 DB DEK + OS 凭据区 KEK 包装
     （不从设备签名私钥派生）——过 Codex 二审
  D4 签名打印模板本地渲染 + XP-58 小票执行 + print_jobs 状态回执
     （承接 M0-3；实机日前可先用 mock spool 验证链路）
  D5 A/B 双槽 + 健康检查 + 升级前快照 + 回滚判定骨架（承接 M0-4）
  E1 登录页 + PIN 快切 + 连接状态条骨架（依赖 Codex C6）
  E3 权限门控路由骨架：按 role × store_features 出 IA；深浅色双模式

【红线提醒】
- Edge 内不写业务校验——校验语义全在 server 命令总线，Edge 只是受约束的
  执行与暂存端（你 M0-4 已做到零业务逻辑越界，继续保持）
- 浏览器不持有敏感状态：IndexedDB 只缓存 UI/字典，不存交易/审计
- 金额渲染一律走 MoneyText
- 增删依赖同时更新两个 lock 文件

【M1 技术债（M0 复核发现，本期顺手处理）】
- estimateCode128Dots 公式漏了起始符/校验符/单侧静区（实际 11n+55，
  代码 11n+23），本次结论碰巧正确但系统性偏低
- 三个函数超 50 行红线：generate-all.ts:57 main()、
  m0-4-edge/ab-upgrade/drill.mjs 的 cmdInstall() 与 cmdRollback()
- dl206-wash.ts:74-75 注释陈旧（说 fallback cutters 在全切后发出，实际只发 cut(0)）

E2 现在就能开工，不必等契约。
```

---

## 下发注意

1. **顺序**：先发 Claude 与 Codex（契约冻结是发令枪），随即发 Gemini 与 Grok
   ——他们各有一部分不依赖契约、可立即开工（Gemini 的 B1/B3、Grok 的 E2）。
2. **仍缺的外部输入**：
   - **模型 API key**（环境变量形式）→ M0-5 转「通过」；M2 AI Gateway 前必须到位
   - **Windows 实机 + 三台打印机** → M0-3/M0-4 实机演练
   - **分支保护**（Settings → Branches → main → Require status checks: build
     与 workspace-check 两项）→ M1 期间 PR 会明显变多，这道闸建议尽快设上
