# Changelog

本项目版本记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。

> **当前路线（2026-07-25）**：按 [ADR-14](adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md)，v2 是唯一活动交付线，并优先交付通用本地 Web Server 与 macOS 测试应用；V2-only 基础裁决沿用 [ADR-13](adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md)。宏发 v1 停止功能开发与独立发版，只保留为迁移源和历史行为参考。

---

# v2 线（通用本地优先产品）

## [Unreleased · v2]

_本节记录**面向用户的变化**；纯内部重构与验证性工作不入 CHANGELOG，去向见 `docs/research/` 与 `docs/superpowers/plans/`。_

### 新增

- 独立 loopback PostgreSQL 16 与 Fastify 生命周期，包含迁移、一次性 bootstrap、持久卷保护和真实数据库就绪门禁。
- 浏览器与 Electron 共用同一 React SPA；桌面端只暴露固定的认证、命令、查询与健康能力，令牌和 cookie 留在主进程。
- 通用 `laundry-desk V2` macOS 未签名本地测试包与隔离验收链；不包含 DMG、签名、公证、自动更新、云部署或 Windows 适配。

> 上述为 Local Foundation 的工程能力，不等于完整柜台工作日已经交付。账本、取衣、补款、统计与交班仍按后续产品切片推进；云部署和 Windows 适配继续延后。

---

# v1 线（宏发单店版，Archived / 已归档）

> 以下仅记录历史实现，不再继续开发、补 tag 或独立发布。需要数据升级时由 `tools/migrate-v1` 只读消费。

## [0.3.0] — 历史未发布实现

### 新增

- 收件拍照：1–3 张，存 `userData/photos/YYYY-MM/`，订单详情可查看
- 58mm 热敏打印：登记单 / 取件条，`PrinterDriver` 抽象接口（ESC/POS 通用）
- 自定义 `media://` 协议安全加载本地照片（含路径穿越防护）

## [0.2.0] — 历史未发布实现

### 新增

- 价格模板与按件计费、折扣
- 付款方式（现金/微信/支付宝/刷卡/挂账）与欠款、取件时补收尾款
- 日/月营业统计与图表（Recharts）、逾期未取列表
- Excel 导入导出（exceljs）

## [0.1.0] — 历史未发布实现

### 新增

- Electron + React 19 + TypeScript strict + Tailwind 4 项目骨架（electron-vite）
- 收件登记 / 取件查询 / 订单列表 / 订单详情 / 客户管理 / 设置页
- 客户按手机号自动去重；4 位取件码（当日池，事务内冲突重试）；`YYYYMMDD-NNNN` 订单号
- SQLite（better-sqlite3 + Drizzle ORM，WAL）；金额整数分存储
- 每日 03:00 自动备份（WAL checkpoint + zip 滚动保留 30 份）+ 手动备份/还原
- IPC 全量 Zod 校验 + 统一 `{ ok, data } | { ok, error }` 信封；`sandbox` / `contextIsolation` / CSP
- GitHub Actions `windows-latest` 构建 + NSIS 安装器 + SHA256
