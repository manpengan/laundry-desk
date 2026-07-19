# laundry-desk

洗衣店柜台管理系统 — 单店单机 Windows 桌面应用，Apple HIG 风格 UI。

覆盖收件登记、取件、客户管理、收款、统计报表、物品拍照、58mm 热敏打印、腾讯云短信通知、多员工账号与审计全流程。

## 状态

| 项       | 值                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| 阶段     | M0（设计完成，待 Gemini 实现 M1）                                                                                    |
| 设计文档 | [docs/superpowers/specs/2026-04-23-laundry-desk-design.md](docs/superpowers/specs/2026-04-23-laundry-desk-design.md) |
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
| M4  | `v0.4.0` → `v1.0.0` | 登录 + 权限 + 审计 + 腾讯云 SMS                                            |

> 上表为 **v1（宏发单店）** 收口路线，仍在进行。

### v2 产品化（2026-07-19 立项，设计已定稿）

从单店工具升级为面向洗衣店行业的产品 + AI-first（BYOK 多厂商大模型、系统内 agent 工作）。设计真源：

- 架构：[docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md](docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md)
- Web UI：[docs/superpowers/specs/2026-07-19-laundry-v2-web-ui-design.md](docs/superpowers/specs/2026-07-19-laundry-v2-web-ui-design.md)
- 决策：[总 RFC + ADR-01…08](docs/adr/2026-07-19-v2-productization-and-ai.md)（全部 Accepted）
- 实施：[V2-M0/M1 计划 + 四 AI 分工](docs/superpowers/plans/2026-07-19-v2-m0-m1-implementation-plan.md)
- 调研：[docs/research/](docs/research/)（顺科复核 + 国内外竞品 + 技术趋势）

v2 里程碑：M0 技术验证 → M1 基座（命令总线 + RLS + Edge）→ M2 柜台核心+只读 AI → M3 会员/通知 → M4 账务/老板端 → M5 AI 完整面 → M6（视觉/小程序/工厂/取送，四子期）。桌面为主、Web 次之。

## 分工

- **Claude** — 设计 / spec / 门禁验收 / code review / ADR — 见 [CLAUDE.md](CLAUDE.md)
- **Codex** — 安全与基座实现 + 关键节点二审（架构 / 安全 / 并发 / 密码学）— 见 [AGENTS.md](AGENTS.md)
- **Gemini** — 领域实现（domain/服务/迁移/工具）— 见 [GEMINI.md](GEMINI.md)
- **Grok** — 端与硬件（edge-agent 桌面 / web 柜台 / 小程序）— 见 [GROK.md](GROK.md)
- **manpengan** — 决策 / UI 走查 / 发版
- v2 分工已拍板，四份任务书见 [docs/superpowers/plans/tasks/](docs/superpowers/plans/tasks/)

## 开发（Gemini 实现 M1 后补）

```bash
pnpm install
pnpm dev            # Electron 开发态
pnpm build:win      # 打包 Windows .exe
pnpm test           # Vitest 单测
pnpm test:e2e       # Playwright E2E
```

## License

私有项目（manpengan 个人所有）。
