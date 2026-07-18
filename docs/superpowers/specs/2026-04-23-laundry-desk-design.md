---
title: laundry-desk 设计文档
date: 2026-04-23
updated: 2026-07-18
version: 1.1
status: approved (v1.1 — 收口路线 + UI 2.0 立项，详见 docs/adr/2026-07-18-liquid-glass-ui-2.md)
authors: claude (brainstorm), manpengan (decision)
---

# laundry-desk — 洗衣店柜台管理系统

## 1. 目标与场景

单店单机 Windows 桌面系统，覆盖洗衣店柜台全流程：收件登记 / 取件 / 客户 / 收款 / 统计 / 打印 / 短信。

- 运行：Windows 10/11（NSIS `.exe` 安装器）
- 开发：macOS 交叉打包（GitHub Actions `windows-latest` 为准）
- 数据：本地 SQLite（WAL + 每日自动备份）

**典型场景：**

- 收件：查回头客 → 录物品明细 → 计价收款 → 生成 4 位取件码 → 打印登记单
- 取件：客户报取件码 / 电话 / 单号 → 查询 → 收尾款 → 标记已取 → 打印取件条
- 管理：店主查看日/月营业额、逾期未取、回头率

## 2. 范围

**In Scope（v1.0.0）：** 收件、取件、订单列表、客户自动去重（按电话）、按件计费、付款方式与欠款、日/月统计、逾期未取、58mm 热敏打印、物品照片、腾讯云 SMS、多员工账号 + 审计日志、Excel 导入导出、自动备份。

**Out of Scope：** 多门店 / 云端同步 / 会员积分储值 / 微信小程序 / RFID / 自动称重。

## 3. 技术栈

| 层       | 选型                                               |
| -------- | -------------------------------------------------- |
| 应用框架 | Electron 32+                                       |
| 前端     | React 19 + TypeScript 5 (strict)                   |
| UI       | Tailwind CSS 4 + shadcn/ui                         |
| 动效     | Framer Motion 11                                   |
| 字体     | SF Pro Display/Text + PingFang SC                  |
| 状态     | Zustand                                            |
| 路由     | React Router 7                                     |
| 数据库   | better-sqlite3 + Drizzle ORM                       |
| 密码哈希 | @node-rs/argon2                                    |
| 构建     | Vite + electron-vite                               |
| 打包     | electron-builder（NSIS）                           |
| 图表     | Recharts                                           |
| 打印     | electron-pos-printer（58mm ESC/POS）               |
| 短信     | @tencentcloud/tencentcloud-sdk-nodejs-sms          |
| Excel    | exceljs                                            |
| 测试     | Vitest（单测）+ Playwright（E2E）                  |
| CI       | GitHub Actions（`windows-latest` 构建 + artifact） |

**UI 视觉规范（v1.1 起以液态玻璃 UI 2.0 为准）：** 设计系统详见 [ADR 2026-07-18](../../adr/2026-07-18-liquid-glass-ui-2.md)——六条语汇（三层玻璃 / 镜面追光 / 液态涟漪 / 磁性焦点 / 呼吸背景 / 深浅同构）、`--lg-*` 设计 token 双主题全量、动效规格表、性能与可及性红线。字体保持 SF Pro + PingFang SC；品牌蓝 `#0071e3`（暗色 `#0A84FF`）；深色模式跟随系统 + settings 手动覆盖。窗口使用系统标准框（实现现状，稳定性优先；`hiddenInset` 仅 Mac 开发态可选项）。

## 4. 数据模型（SQLite + Drizzle）

金额一律用**整数分**存储（杜绝浮点）。

| 表             | 关键字段                                                                                                                                                                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customers`    | id, name, phone (unique), vip_level, total_orders, total_spent, created_at, updated_at                                                                                                                                                                                                                                                  |
| `orders`       | id, order_no (unique, `YYYYMMDD-NNNN`), pickup_code (char(4)), customer_id (fk), status (pending/ready/picked_up/cancelled), total_amount, paid_amount, payment_method (cash/wechat/alipay/card/unpaid), receive_date, expected_pickup_date, actual_pickup_at, staff_id (fk), picked_up_by (fk nullable), notes, created_at, updated_at |
| `order_items`  | id, order_id (fk cascade), item_type, service_type (wash/dry_clean/iron), quantity, unit_price, subtotal, item_notes                                                                                                                                                                                                                    |
| `order_photos` | id, order_id (fk cascade), file_path (相对 userData), taken_at                                                                                                                                                                                                                                                                          |
| `staffs`       | id, username (unique), password_hash (Argon2), display_name, role (admin/staff), is_active, created_at, last_login_at                                                                                                                                                                                                                   |
| `sms_log`      | id, order_id (fk), phone, content, status (pending/sent/failed), provider_response (json), sent_at                                                                                                                                                                                                                                      |
| `settings`     | key (pk), value (json), updated_at                                                                                                                                                                                                                                                                                                      |
| `audit_log`    | id, staff_id (fk nullable), action (create/update/delete/pickup/cancel/login/export), entity, entity_id, diff (json), created_at                                                                                                                                                                                                        |

**索引：** `orders(pickup_code)`、`orders(customer_id, status, receive_date)`、`audit_log(created_at)`、`customers(phone) unique`、`orders(order_no) unique`。

**取件码策略：** 00:00 重置当日池，随机 4 位数字，事务内冲突重试 ≤ 3 次（单店同日 1 万单封顶完全够用）。

**订单号策略：** `YYYYMMDD-NNNN` 顺序号（事务内 `SELECT max(nnnn)+1`，同日 9999 封顶）。

**默认 settings keys：** `shop.name`、`shop.address`、`printer.enabled`、`printer.width`、`sms.enabled`、`sms.tencent.secret_id`、`sms.tencent.secret_key`（M4 加密存储）、`sms.template_id`、`price_templates`（JSON 数组）。

**备份：** `%APPDATA%/laundry-desk/backups/` 下每日 03:00 zip `.db`，保留最新 30 份滚动删除；设置页提供"立即备份 / 从备份还原"。

## 5. 架构分层

```
src/
  main/           # Node 主进程（持有 DB）
    db/           # Drizzle schema / migrations / backup
    services/     # 业务逻辑（无 Electron 依赖，可单测）
    ipc/          # IPC handlers，按领域分组
    window.ts
    index.ts
  preload/        # 桥接，暴露类型安全 window.api
  renderer/       # React UI
    routes/       # Home / Receive / Pickup / Orders / OrderDetail / Customers / Stats / Settings / Login
    components/ui/  # shadcn/ui 定制
    stores/       # Zustand
    lib/api.ts    # window.api 封装
    styles/globals.css
  shared/         # main ↔ renderer 共享类型 + Zod schema + 错误码
  tests/
```

**硬约束：**

- `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` / CSP 严格
- Renderer 零 Node/DB 访问，全走 IPC
- IPC 命名 `<domain>:<action>`（如 `orders:create`）；入参一律过 Zod；返回 `{ ok: true, data } | { ok: false, error: { code, message } }`
- Service 层无 Electron 依赖；接受 db client 注入（测试用 in-memory SQLite）
- 单文件 ≤ 400 行、函数 ≤ 50 行、嵌套 ≤ 4 层；金额零浮点；无硬编码密钥

## 6. 核心工作流

### 6.1 收件

电话查回头客 → 明细多行 → 付款方式 + 实收 → 事务生成 `pickup_code` + `order_no` → 写 `orders` + `order_items`（+ 可选 `order_photos`）→ 更新 `customers.total_orders/total_spent` → `audit_log` → （M3）打印登记单。

### 6.2 取件

取件码（优先）/ 电话 / 单号 / 姓名查询 → 多条时列表选 → 有欠款先收 → `status = picked_up`、`actual_pickup_at`、`picked_up_by` → `audit_log` → （M3）打印取件条。

### 6.3 自动备份

`app.ready` 启动 `node-cron` 03:00 → `PRAGMA wal_checkpoint(TRUNCATE)` → 复制 `.db` → zip → 滚动保留 30 份。

### 6.4 短信通知（M4）

手动/批量触发 → Service 调腾讯云 SMS SDK → 写 `sms_log`（pending → sent/failed）→ 状态回填订单详情。

## 7. 分期路线图

| 期     | Tag                 | 交付                                                                                              |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------- |
| **M1** | `v0.1.0`            | 项目骨架 + Apple HIG 设计系统 + 收件/取件/列表/详情 + 客户自动去重 + 自动备份 + Windows NSIS 打包 |
| **M2** | `v0.2.0`            | 价格模板 + 按件计费 + 折扣 + 付款/欠款 + 日/月报表（Recharts）+ 逾期未取 + Excel 导入导出         |
| **M3** | `v0.3.0`            | 收件拍照（1–3 张，存 `userData/photos/YYYY-MM/`）+ 58mm 热敏打印登记单 / 取件条                   |
| **M4** | `v0.4.0`            | 登录（Argon2）+ 权限（admin/staff）+ 审计日志全面绑定 + 腾讯云 SMS 可取件通知（可关闭）           |
| **M5** | `v0.5.0`            | 液态玻璃 UI 2.0 设计系统（与 M4 并行，见 ADR 2026-07-18）                                         |
| **GA** | `v1.0.0`            | M4 + M5 完成、门禁全绿后发布                                                                      |

**2026-07-18 路线修订（路线 A，manpengan 批准）：** M1–M3 实现已完成于 `codex/hongfa-m1-release`，先走门禁验收合并 main、补打 `v0.1.0`–`v0.3.0` tag，并清理 P0/P1 技术债（GitHub milestone「收口: v0.3.0」）；随后 M4（main 进程为主）与 M5（renderer 为主）双线并行。

## 8. 验收门禁（每期必过）

**质量：** TS strict 零错、ESLint/Prettier 零警、文件/函数/嵌套红线、无硬编码密钥、所有 IPC 过 Zod。
**UI（M5 起）：** 双主题全路由走查、同屏 backdrop-filter ≤ 8、动画仅 transform/opacity/filter、Windows 实机 60fps、reduced-motion 降级、组件零硬编码色值（`--lg-*` token 化）。
**测试：** Service 单测覆盖率 ≥ 70%、Playwright E2E 覆盖本期核心路径、备份可从 zip 还原到新安装。
**交付：** GH Actions `windows-latest` 构建绿灯；Windows 10/11 实机冒烟（manpengan）；`.exe` 大小记录基线；GitHub Release 附安装器 + SHA256。
**文档：** `README.md` 截图更新；`docs/CHANGELOG.md` 本期条目。

## 9. 分工

| 角色                  | 职责                                       | 工具        |
| --------------------- | ------------------------------------------ | ----------- |
| **Claude (Opus 4.7)** | brainstorm / spec / 门禁验收 / code review | Claude Code |
| **Codex**             | 关键节点二次审查（架构 / 安全 / 并发）     | Codex CLI   |
| **Gemini**            | M1~M4 主力实现、测试编写、修 build         | Gemini CLI  |
| **manpengan**         | 决策 / UI 走查 / 发版                      | —           |

**节奏：** 每期开始 Claude 在 milestone issue 补实施细节 → Gemini 提 PR → Claude 审 → Codex 关键点复审 → Claude 过门禁清单 → manpengan tag release。

## 10. 风险与缓解

| 风险                                                   | 缓解                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Mac 交叉打 Windows exe，better-sqlite3 native 模块失败 | GH Actions `windows-latest` 为准；本地 `pnpm rebuild`；electron-builder `buildDependenciesFromSource: false` |
| 打印机型号差异                                         | M3 抽象 `PrinterDriver` 接口，先支持 58mm 通用 ESC/POS，型号配置化                                           |
| 腾讯云 SMS 模板审核周期                                | Provider 可替换；模板 id 从 settings 读；无短信时仍可发版                                                    |
| SQLite 单文件损坏                                      | WAL + 每日 zip + 备份校验任务                                                                                |
| Electron XSS → 任意代码                                | contextIsolation + sandbox + CSP + 所有 IPC 过 Zod                                                           |
| 密钥泄漏（短信 SecretKey）                             | M4 用 OS keychain（`keytar`）加密存储，非明文入库                                                            |

## 11. 假设

单店单机；日单量 ≤ 1000；员工 ≤ 10；打印机 58mm ESC/POS 兼容；柜台机器可联外网（为 SMS / 备份到外部 NAS 留空间，v1 不做）；GitHub 用户名 `manpengan`，仓库 **public**。

## 12. Open Questions

无。后续变更走 `docs/adr/YYYY-MM-DD-<topic>.md`。
