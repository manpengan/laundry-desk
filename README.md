# laundry-desk

洗衣店柜台管理系统 — 单店单机 Windows 桌面应用，液态玻璃（Liquid Glass）风格 UI。

覆盖收件登记、取件、客户管理、收款、统计报表、物品拍照、58mm 热敏打印、腾讯云短信通知、多员工账号与审计全流程。

## 状态

| 项       | 值                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| 阶段     | M1–M3 已实现（`codex/hongfa-m1-release` 收口验收中）→ M4 ∥ M5 并行                                                                                    |
| 设计文档 | [docs/superpowers/specs/2026-04-23-laundry-desk-design.md](docs/superpowers/specs/2026-04-23-laundry-desk-design.md) |
| UI 设计  | [docs/adr/2026-07-18-liquid-glass-ui-2.md](docs/adr/2026-07-18-liquid-glass-ui-2.md) — 液态玻璃 UI 2.0               |
| 目标平台 | Windows 10 / 11（NSIS `.exe`）                                                                                       |
| 开发平台 | macOS（GitHub Actions `windows-latest` 构建为准）                                                                    |

## 技术栈

Electron 32 · React 19 · TypeScript 5 · Tailwind CSS 4 · shadcn/ui · Framer Motion 11 · Zustand · Drizzle ORM · better-sqlite3 · Vite · electron-builder · Recharts · Playwright · Vitest

## 路线图

| 期  | Tag                 | 范围                                                                       |
| --- | ------------------- | -------------------------------------------------------------------------- |
| M1  | `v0.1.0`            | 骨架 + Apple UI + 收件/取件/列表/详情 + 客户去重 + 自动备份 + Windows 打包 |
| M2  | `v0.2.0`            | 价格模板 + 按件计费 + 付款/欠款 + 日/月报表 + 逾期 + Excel 导入导出        |
| M3  | `v0.3.0`            | 收件拍照 + 58mm 热敏打印登记单 / 取件条                                    |
| M4  | `v0.4.0`            | 登录 + 权限 + 审计 + 腾讯云 SMS（与 M5 并行）                              |
| M5  | `v0.5.0`            | 液态玻璃 UI 2.0（token / 动效 / 深色模式 / 性能门禁，与 M4 并行）          |
| GA  | `v1.0.0`            | M4 + M5 完成、门禁全绿后发布                                               |

> 2026-07-18 路线修订（路线 A）：M1–M3 先走收口门禁（验收 → 合并 main → 补 tag → 清技术债，见 milestone「收口: v0.3.0」），随后 M4 / M5 双线并行。

## 分工

- **Claude**（Opus 4.7）— brainstorm / spec / 门禁验收 / code review — 见 [CLAUDE.md](CLAUDE.md)
- **Codex** — 关键节点技术二审（架构 / 安全 / 并发）— 见 [AGENTS.md](AGENTS.md)
- **Gemini** — 主力实现、测试、修 build — 见 [GEMINI.md](GEMINI.md)
- **manpengan** — 决策 / UI 走查 / 发版

## 开发

```bash
npm install
npm run dev         # Electron 开发态
npm run build:win   # 打包 Windows .exe（NSIS）
npm test            # Vitest 单测
npm run test:e2e    # Playwright E2E
npm run typecheck   # TS strict 检查
```

## License

私有项目（manpengan 个人所有）。
