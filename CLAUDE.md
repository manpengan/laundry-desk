# CLAUDE.md — laundry-desk

Claude（Opus 4.7）在本项目中的入场指引。

> **当前状态（ADR-66）**：Claude draft3.1a 与 ADR-14 是通用 V2 的架构与 UI 基线；当前由
> **Codex** 负责 Windows V2 定制 EXE 与宏发受控试点的设计、实现与验收。本文其余内容保留为历史门禁
> 参考；Claude 如参与，仅提供非阻塞可选复审，不拥有当前 spec、contracts 或 PR
> 放行权。

## 你在这个项目里的角色

**历史角色：设计与门禁**。当前不在关键路径，不写实现代码，不 scaffold，不装依赖。

当前实现与设计由 Codex 负责，见 `AGENTS.md` 与 ADR-66。

## 入场必读

1. [`docs/adr/2026-08-29-adr-66-windows-hongfa-pilot.md`](docs/adr/2026-08-29-adr-66-windows-hongfa-pilot.md) — 当前 Windows/宏发主线裁决
2. [`docs/research/2026-08-29-windows-port-findings-and-build-host.md`](docs/research/2026-08-29-windows-port-findings-and-build-host.md) — Windows 实机证据
3. [`docs/adr/2026-08-10-adr-37-cloud-web-primary-delivery.md`](docs/adr/2026-08-10-adr-37-cloud-web-primary-delivery.md) — Cloud Web 主形态与已完成 1–4 基线
4. [`docs/adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md`](docs/adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md) — 通用 V2 架构基线
5. [`docs/adr/2026-07-31-adr-16-edge-operations-scope-ratification.md`](docs/adr/2026-07-31-adr-16-edge-operations-scope-ratification.md) — 契约面新增须附 ADR
6. [`docs/superpowers/specs/2026-07-25-local-first-v2-product-design.md`](docs/superpowers/specs/2026-07-25-local-first-v2-product-design.md) — 产品设计基线
7. [`docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md`](docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md) — Claude 架构基线
8. [`docs/superpowers/specs/2026-07-19-laundry-v2-web-ui-design.md`](docs/superpowers/specs/2026-07-19-laundry-v2-web-ui-design.md) — Claude UI 基线
9. [`docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md`](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md) — V2-only 基础裁决
10. [`AGENTS.md`](AGENTS.md) — 当前 owner 与执行入口

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
- 路线图变更 → 更新本文件、`AGENTS.md` 与对应 ADR
- 新风险 → 补 spec §10

## 不做

- 不向 `src/` 增加 v1 功能；迁移兼容问题仅作非阻塞复审
- 不装 npm 依赖
- 不拥有 build、发版或 PR 放行权
- 不恢复 ADR-13 已终止的 v1 M4/M5/GA 路线
