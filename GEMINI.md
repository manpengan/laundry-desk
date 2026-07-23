# GEMINI.md — laundry-desk

Gemini 在本项目中的历史入场指引。

> **当前状态（ADR-12 / ADR-13）**：Gemini 已退出实现与冻结关键路径；v2 是唯一活动交付线，v1 已冻结为迁移源与历史参考。本文其余内容仅保留为 v1/早期分工历史；未合并分支不得继续铺生产实现，只可作为 **Grok** 取用的候选输入。若参与复审，不得阻塞交付。

## 你在这个项目里的历史角色

把 Claude 的 spec 落成能在 Windows 10/11 上跑的 exe。包括：

- 代码实现（main / preload / renderer / shared / services）
- 测试编写（Vitest + Playwright）
- 构建配置（Vite / electron-vite / electron-builder）
- 修 build、修测试、修 CI
- 每期提一个 Pull Request，通过门禁后由 manpengan 合并并 tag release

## 入场必读（按顺序）

1. **产品裁决**：[`ADR-13`](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md)
2. **设计真源**：[`docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md`](docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md)
3. **当前 owner**：[`GROK.md`](GROK.md)
4. **历史 v1 设计**：[`docs/superpowers/specs/2026-04-23-laundry-desk-design.md`](docs/superpowers/specs/2026-04-23-laundry-desk-design.md)（已归档）
5. **代码红线**：`~/.claude/rules/common/coding-style.md`

## 代码红线（硬性）

| 项         | 红线                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| TypeScript | `strict: true`，零 `any`，必要时用 `unknown` + Zod                               |
| 文件       | ≤ 400 行                                                                         |
| 函数       | ≤ 50 行                                                                          |
| 嵌套       | ≤ 4 层                                                                           |
| 金额       | 一律 `int`（分），禁浮点                                                         |
| 密钥       | 不入代码、不入库明文（M4 用 `keytar`）                                           |
| IPC        | 入参过 Zod，返回 `{ ok: true, data } \| { ok: false, error: { code, message } }` |
| Electron   | `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` / 严格 CSP |
| 不可变     | 数据操作返回新对象，避免就地修改                                                 |

## 目录骨架（M1 一次落盘）

```
src/
  main/        # Node 主进程：index.ts / window.ts / db / services / ipc
  preload/     # 桥接：暴露 window.api
  renderer/    # React UI：routes / components / stores / lib / styles
  shared/      # 共享类型 + Zod + 错误码
tests/
  unit/        # Vitest：对 services 单测
  e2e/         # Playwright：覆盖本期核心路径
```

## 历史 v1 分期任务（已归档，禁止继续执行）

**按顺序做，不跳期。每期完成一轮"代码 → 测试 → CI 绿 → 实机冒烟 → 过门禁 → tag"。**

### M1（v0.1.0）— 基础

1. 脚手架：Electron + Vite + electron-vite + TS + Tailwind 4 + shadcn/ui + Framer Motion + Zustand + React Router 7
2. Apple HIG 设计系统：字体、色彩 token、全局 CSS、基础组件（Button / Card / Input / Dialog / Sheet / Toast）
3. DB 层：Drizzle schema + migrations（8 张表，见 spec §4）+ better-sqlite3 连接
4. IPC 层：`orders` / `customers`（入参 Zod，返回统一信封）
5. Service 层：`orderService`、`pickupCodeService`、`customerService`、`backupService`
6. 页面：Home / Receive / Pickup / Orders / OrderDetail / Customers（暂空）/ Settings / Stats（暂空）/ Login（暂锁）
7. 自动备份：node-cron 03:00 → WAL checkpoint → zip → rotate 30
8. 构建：`electron-builder` NSIS，输出 `laundry-desk-Setup-0.1.0.exe`
9. GitHub Actions：`windows-latest` 构建 + 上传 artifact
10. 单测：`pickupCodeService` / `orderService.create` / `customerService.upsertByPhone`
11. E2E：收件→取件的完整流程

### M2（v0.2.0）— 收款 & 统计

- `settings.price_templates` + 价格 autocomplete
- 付款方式、折扣、欠款
- 日/月报表（Recharts）、逾期未取列表
- Excel 导入导出（exceljs）：客户 / 订单 / 明细

### M3（v0.3.0）— 照片 & 打印

- 收件页：调用摄像头 or 选本地文件，存 `userData/photos/YYYY-MM/<order>_<n>.jpg`
- `PrinterDriver` 抽象 + 58mm ESC/POS 实现（`electron-pos-printer`）
- 登记单模板：店名 / 单号 / 取件码 / 电话尾 4 位 / 明细表 / 总价
- 取件条模板：取件码 / 单号 / 取件人 / 金额结清

### M4（v0.4.0 → v1.0.0）— 员工 & 短信

- Argon2 密码哈希，Login 页
- 权限中间件（IPC handler 包装层）：admin 可进 Settings / Customers，staff 仅收件 / 取件
- `audit_log` 全面绑定（每个写入 IPC）
- 腾讯云 SMS Provider + settings 配置页 + `sms_log` + 订单详情"通知客户"按钮
- **SecretKey 用 `keytar` 存 OS keychain，不入库**

## 开发与提交流程

1. 每期建一个分支：`feat/m1-base` / `feat/m2-payment-stats` / ...
2. 小步提交，每个 commit 聚焦一件事
3. 完成后本地跑：`pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e`
4. Push → GH Actions `windows-latest` 绿灯 → 开 PR
5. PR 描述里附 CLAUDE.md 的门禁清单勾选状态
6. Claude 审 → Codex 关键点复审 → manpengan 走查 Windows 实机 → 合并 → tag release

## 构建 & 发布命令

```bash
pnpm install              # 装依赖
pnpm dev                  # Electron 开发态（Mac 用于开发）
pnpm typecheck            # tsc --noEmit
pnpm lint                 # eslint + prettier --check
pnpm test                 # vitest run
pnpm test:e2e             # playwright test
pnpm build:win            # electron-builder --win nsis（本地冒烟）
# 正式包走 GH Actions windows-latest workflow
```

## 遇到问题

1. **better-sqlite3 native 模块**：`pnpm rebuild` + `electron-builder` 的 `buildDependenciesFromSource: false`
2. **Apple 风样式在 Windows 下的降级**：`titleBarStyle` 和 vibrancy 在 Windows 下回退为实心圆角卡片，不强求毛玻璃
3. **短信模板未审核**：M4 允许 `sms.enabled=false` 发版，模板过了再开
4. **Bug 卡住 > 1 小时**：在 PR 评论 `@codex` 请求关键点二审

## 不做

- 不继续任何 v1 M4/M5/GA 功能或独立发版
- 不改 spec（有改动要求找 Claude 走 brainstorm 流程）
- 不跳期做后面的功能
- 不关 TS strict / 不用 `@ts-ignore` 压错
- 不在 renderer 里 `require('better-sqlite3')` 或 `fs`
- 不在代码里硬编码密钥、店名、路径
