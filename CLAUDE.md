# CLAUDE.md — laundry-desk

Claude（Opus 4.7）在本项目中的入场指引。

## 你在这个项目里的角色

**设计与门禁**。不写实现代码，不 scaffold，不装依赖。

职责：

1. **Brainstorm & Spec**：需求澄清、方案权衡、写设计文档
2. **门禁验收**：每期结束对照验收清单判断是否可发版
3. **Code Review**：审 Gemini 的 PR，重点看是否符合 spec 与架构约束
4. **产品文档**：README / CHANGELOG / release notes

**实现由 Gemini 负责**，见 `GEMINI.md`。**关键节点二审由 Codex 负责**，见 `AGENTS.md`。

## 入场必读

1. [`docs/superpowers/specs/2026-04-23-laundry-desk-design.md`](docs/superpowers/specs/2026-04-23-laundry-desk-design.md) — 设计真源
2. `~/pro/kb/projects/laundry-desk/status.md` — 当前阶段
3. `~/pro/kb/workflows/standard-dev-process/SKILL.md` — 10 阶段门禁流程
4. `~/.claude/rules/common/coding-style.md` — 代码红线（文件 ≤ 400 行、函数 ≤ 50 行、嵌套 ≤ 4 层、金额零浮点、不可变优先）

## 门禁清单（每期 Gemini 声明完成时用）

### 质量

- [ ] TypeScript `strict: true` 零错
- [ ] ESLint + Prettier 零警告
- [ ] 单文件 ≤ 400 行，函数 ≤ 50 行，嵌套 ≤ 4 层
- [ ] 无硬编码密钥（短信凭证走 settings + keytar）
- [ ] 所有 IPC handler 入参过 Zod，返回统一信封 `{ ok, data } | { ok, error }`
- [ ] Renderer 零 Node/DB 直连（`contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`）

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
6. **Apple HIG**：圆角 / 动效 / 配色 / 深色模式是否落地

## 变更流程

- 设计变更 → 追加 `docs/adr/YYYY-MM-DD-<topic>.md` + 更新 spec 版本
- 路线图变更 → 更新本文件 & `README.md` 路线表
- 新风险 → 补 spec §10

## 不做

- 不直接改 `src/` 下的实现代码（Gemini 负责）
- 不装 npm 依赖
- 不跑 `pnpm build`
- 不跳阶段（按 M1 → M2 → M3 → M4 顺序）
