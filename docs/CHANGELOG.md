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
- 开单与权威计价：按件选服务与品类，支持折扣、加急、附加与运费；金额全程整数分，计价以服务端为准。
- 收款与欠款：现金/微信/支付宝/刷卡多方式收款，支持部分收款留欠款、独立欠款补缴与退款，支付流水只追加。
- 挂单与撤销：未结订单可挂起或撤销，危险操作走统一二次确认。
- 取衣：整单或按件部分取衣，取衣时可直接补收尾款。
- 顾客：按手机号建档与去重，支持手机号、姓名前缀与取件码统一查找。
- 营业日、统计与交班：以门店时区归属营业日，提供当日统计、CSV 导出与交班结账。
- 柜台界面：三栏工作台与三栏开单页，含订单列表/详情抽屉、取衣页、欠款页、统计页与交班面板。

> 上述柜台能力已在真实 PostgreSQL 上通过验收：服务端走真实命令总线覆盖开单 → 补款 → 取衣 → 交班，浏览器 E2E 覆盖选价目 → 开单收部分款 → 取衣补齐结清。仍未交付：模拟打印（切片 5）、macOS App smoke、云部署与 Windows 适配。

- 价目维护（[ADR-15](adr/2026-07-28-adr-15-catalog-maintenance-unfreeze.md)）：设置页可新增价目、改价与停用；停用只下架不删除，历史订单的价格快照不受影响。仅管理员可改价。
- 模拟打印：打印任务渲染成 UTF-8 文本落盘，柜台可看到 queued/printing/done/failed 并重试或补打；产物可经鉴权按任务 id 下载，下载前与记录的哈希校验。本地栈已默认开启，无需额外配置。产物目录有单份大小、总量与份数上限，超出时按最旧优先淘汰；该目录随本地栈容器生命周期存在，`local:down` 后回收。

> 此前全新安装无法开单——价目表没有种子数据，契约面又只有价目查询没有写入命令，只能绕过应用直接写库。价目维护补齐后，全新安装的可用路径为：登录 → 设置页录入价目 → 开单。

### 修复

- 修正 `orders` 与 `payments` 的 `business_date` 约束正则（`\\d` → `\d`）。此前该约束拒绝任何合法日期，导致真实 PostgreSQL 上开单与收款全部失败。**已存在的本地数据库需要执行 `pnpm local:reset` 重建**，迁移校验和账本会拒绝直接复用。
- Electron 壳重新同步 `apps/web` 构建产物；此前柜台 UI 变更未回灌，壳内仍是旧版 SPA。

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
