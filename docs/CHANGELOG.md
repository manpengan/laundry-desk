# Changelog

本项目版本记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。

> **状态说明（2026-07-18）**：v0.1.0–v0.3.0 的实现已完成于 `codex/hongfa-m1-release` 分支，正在走收口门禁验收；验收通过合并 main 后依次补打 tag，届时移除「待收口」标注。
>
> **两条线并行（2026-07-20 起）**：下方 **v2 线**记录产品化重构（PostgreSQL + Fastify monorepo，ADR-01…09）；**v1 线**（`[Unreleased · v1]` 及以下全部 0.x 条目）继续记录宏发单店版 M1–M4 收口，两条线互不作废。

---

# v2 线（产品化 + AI 能力层）

## [Unreleased · v2]

_本节记录**面向用户的变化**；纯内部重构与验证性工作不入 CHANGELOG，去向见 `docs/research/` 与 `docs/superpowers/plans/`。_

### 进行中

- **V2-M1 基座**：contracts@v0.1.0 冻结中（A1–A7 逐组评审，见 [M1 门禁资产索引](superpowers/plans/tasks/m1-acceptance/README.md)）；命令总线 + RLS 接入 + 审计 + Tool Registry + Policy Engine v0 + Edge v0
- 设计变更新增 [ADR-09 命令元数据字段精确化](adr/2026-07-20-adr-09-command-metadata-precision.md)（Proposed）

### 已完成（未发版）

- **V2-M0 技术验证收口**（2026-07-19）：六项 spike，M0-1/2/3/4/6 通过、M0-5 待真实模型 key 复验；结论见 [findings](research/2026-07-19-v2-m0-findings.md)

---

# v1 线（宏发单店版）

## [Unreleased · v1]

- 路线 A 收口：M1–M3 门禁验收、P0/P1 技术债清理（详见 milestone「收口: v0.3.0」）
- M4（v0.4.0）：登录（Argon2）+ 权限（admin/staff）+ 审计全绑定 + 腾讯云 SMS
- M5（v0.5.0）：液态玻璃 UI 2.0 设计系统（见 [ADR](adr/2026-07-18-liquid-glass-ui-2.md)）

## [0.3.0] — 待收口 tag

### 新增

- 收件拍照：1–3 张，存 `userData/photos/YYYY-MM/`，订单详情可查看
- 58mm 热敏打印：登记单 / 取件条，`PrinterDriver` 抽象接口（ESC/POS 通用）
- 自定义 `media://` 协议安全加载本地照片（含路径穿越防护）

## [0.2.0] — 待收口 tag

### 新增

- 价格模板与按件计费、折扣
- 付款方式（现金/微信/支付宝/刷卡/挂账）与欠款、取件时补收尾款
- 日/月营业统计与图表（Recharts）、逾期未取列表
- Excel 导入导出（exceljs）

## [0.1.0] — 待收口 tag

### 新增

- Electron + React 19 + TypeScript strict + Tailwind 4 项目骨架（electron-vite）
- 收件登记 / 取件查询 / 订单列表 / 订单详情 / 客户管理 / 设置页
- 客户按手机号自动去重；4 位取件码（当日池，事务内冲突重试）；`YYYYMMDD-NNNN` 订单号
- SQLite（better-sqlite3 + Drizzle ORM，WAL）；金额整数分存储
- 每日 03:00 自动备份（WAL checkpoint + zip 滚动保留 30 份）+ 手动备份/还原
- IPC 全量 Zod 校验 + 统一 `{ ok, data } | { ok, error }` 信封；`sandbox` / `contextIsolation` / CSP
- GitHub Actions `windows-latest` 构建 + NSIS 安装器 + SHA256
