# CLAUDE.md — laundry-desk

Claude（Opus 4.7）在本项目中的入场指引。

> **当前状态（ADR-10，2026-07-21）**：Claude 已退出设计、冻结、实现和验收关键路径。后续由 Codex 单一负责设计与开发，Grok 受约束协助。本文其余内容保留为历史门禁参考；Claude 如参与，仅提供非阻塞可选复审，不拥有当前 spec、contracts 或 PR 放行权。

## 你在这个项目里的角色

**历史角色：设计与门禁**。当前不在关键路径，不写实现代码，不 scaffold，不装依赖。

职责：

1. **Brainstorm & Spec**：需求澄清、方案权衡、写设计文档
2. **门禁验收**：每期结束对照验收清单判断是否可发版
3. **Code Review**：审 Gemini 的 PR，重点看是否符合 spec 与架构约束
4. **产品文档**：README / CHANGELOG / release notes

当前实现与设计由 Codex 负责，见 `AGENTS.md`；Grok 协助边界见 `GROK.md`。

## 入场必读

1. [`docs/superpowers/specs/2026-04-23-laundry-desk-design.md`](docs/superpowers/specs/2026-04-23-laundry-desk-design.md) — 设计真源（v1.1）
2. [`docs/adr/2026-07-18-liquid-glass-ui-2.md`](docs/adr/2026-07-18-liquid-glass-ui-2.md) — 液态玻璃 UI 2.0 设计系统（token / 动效 / 性能红线）
3. `~/pro/kb/projects/laundry-desk/status.md` — 当前阶段
4. `~/pro/kb/workflows/standard-dev-process/SKILL.md` — 10 阶段门禁流程
5. `~/.claude/rules/common/coding-style.md` — 代码红线（文件 ≤ 400 行、函数 ≤ 50 行、嵌套 ≤ 4 层、金额零浮点、不可变优先）

## 门禁清单（每期 Gemini 声明完成时用）

### 质量

- [ ] TypeScript `strict: true` 零错
- [ ] ESLint + Prettier 零警告
- [ ] 单文件 ≤ 400 行，函数 ≤ 50 行，嵌套 ≤ 4 层
- [ ] 无硬编码密钥（短信凭证走 settings + keytar）
- [ ] 所有 IPC handler 入参过 Zod，返回统一信封 `{ ok, data } | { ok, error }`
- [ ] Renderer 零 Node/DB 直连（`contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`）

### UI（M5 起）

- [ ] 组件零硬编码色值 / 阴影 / 圆角（全走 `--lg-*` token）
- [ ] 深浅双主题全路由走查（跟随系统 + settings 手动覆盖）
- [ ] 同屏 `backdrop-filter` ≤ 8 层；列表滚动区无逐行玻璃
- [ ] 动画仅 `transform` / `opacity` / `filter`
- [ ] Windows 实机 60fps（页面切换 / 涟漪连点 / 列表滚动）
- [ ] `prefers-reduced-motion` 与 `ui.reduce_motion` 降级生效

### 测试

- [ ] Service 层 Vitest 覆盖率 ≥ 70%
- [ ] Playwright E2E 覆盖本期核心路径
- [ ] 备份文件可还原到全新安装

### 交付

- [ ] GH Actions `windows-latest` 构建绿灯
- [ ] Windows 10/11 实机冒烟（manpengan 走查）
- [ ] `.exe` 大小记录基线（防膨胀）
- [ ] GitHub Release 附 NSIS 安装器 + SHA256

### 文档

- [ ] README 截图更新
- [ ] `docs/CHANGELOG.md` 本期条目

## Code Review 重点

1. **边界**：Renderer 有无直接 `require('better-sqlite3')` 之类越界
2. **输入验证**：IPC / 服务边界有无 Zod
3. **事务**：收件 / 取件 / 备份等多表写入是否包事务
4. **金额**：是否全程用 `int`（分），禁浮点
5. **错误处理**：无 `catch` 吞异常、无裸 `any`、不静默失败
6. **液态玻璃 UI 2.0**：是否只引用 `--lg-*` token、动效是否用 ADR 规格曲线、性能红线是否守住（见 `docs/adr/2026-07-18-liquid-glass-ui-2.md`）

## 变更流程

- 设计变更 → 追加 `docs/adr/YYYY-MM-DD-<topic>.md` + 更新 spec 版本
- 路线图变更 → 更新本文件 & `README.md` 路线表
- 新风险 → 补 spec §10

## 不做

- 不直接改 `src/` 下的实现代码（Gemini 负责）
- 不装 npm 依赖
- 不跑 build（`npm run build` / `build:win` 由 Gemini / CI 负责）
- 不跳阶段（收口 v0.3.0 → M4 ∥ M5 → v1.0.0；M4 与 M5 可并行，其余按序）
