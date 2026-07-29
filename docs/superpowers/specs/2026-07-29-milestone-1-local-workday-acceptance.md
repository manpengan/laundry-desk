# 里程碑 1 验收记录：本地单机完整柜台工作日

> 日期：2026-07-29
> 状态：**已达成**
> 裁决依据：[ADR-14 §5](../../adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md)
> 设计：[通用 V2 本地优先产品设计](2026-07-25-local-first-v2-product-design.md)

本文记录 ADR-14 §5 定义的首个里程碑达成情况：**逐条列出验收口径、支撑证据，以及覆盖到哪一层**。
不夸大——有的能力只有服务端覆盖，没有进端到端，下表如实标注。

## 1. 逐条对照

| ADR-14 §5 口径                         | 状态 | 覆盖层                                                              |
| -------------------------------------- | ---- | ------------------------------------------------------------------- |
| 密码登录                               | ✅   | 真实 PG + 浏览器 E2E + macOS 打包应用                               |
| PIN 员工切换                           | ✅   | 真实 PG（`PG fixture supports login + PIN + refresh`）；UI 未进 E2E |
| 顾客查询/建档                          | ✅   | 真实 PG 命令总线；浏览器 E2E 经开单建档                             |
| 开单 + 权威计价                        | ✅   | 真实 PG + 浏览器 + macOS；三处都断言服务端定价而非客户端传值        |
| 折扣 / 附加 / 加急 / 运费              | ✅   | 服务端单测与命令总线；未进 E2E                                      |
| 收款、欠款                             | ✅   | 真实 PG + 浏览器 + macOS（收部分款留欠款）                          |
| 挂单与撤销                             | ✅   | 服务端命令总线；未进 E2E                                            |
| 订单列表/详情                          | ✅   | 服务端查询 + Web 单测；未进 E2E                                     |
| 整单/部分取衣、取衣补款                | ✅   | 真实 PG + 浏览器 + macOS                                            |
| 独立欠款补缴                           | ✅   | 真实 PG（`payment.repay`）；未进 E2E                                |
| 今日统计与交班结账                     | ✅   | 真实 PG（`shift.close` 走危险确认流程）；未进 E2E                   |
| 文件型模拟打印（可观察/可失败/可重试） | ✅   | 真实文件系统 + 真实 PG + 对运行栈实跑                               |
| 同一 React UI 跑在浏览器与 macOS App   | ✅   | 同一 SPA、同一 contracts；两侧各跑通同一条工作日                    |
| 验收使用真实 PostgreSQL                | ✅   | 见下节                                                              |

**额外交付**（不在 §5 原文，但里程碑离不开）：价目维护
（[ADR-15](../../adr/2026-07-28-adr-15-catalog-maintenance-unfreeze.md)）。没有它，全新安装
的价目表为空，`order.receive` 命中不到在架价目，**开不出第一单**。

## 2. 验收证据

| 门禁                            | 结果                                                    |
| ------------------------------- | ------------------------------------------------------- |
| 服务端 vs 真实 PostgreSQL       | **500/500，0 skipped**（CI 的 no-skip 门禁强制）        |
| 浏览器 E2E（真实 Fastify + PG） | **2/2**                                                 |
| macOS 打包应用验收              | `LOCAL_ACCEPTANCE_OK`，`local-mac.spec.ts` 通过，exit 0 |
| `pnpm workspace:check`          | 全绿（format / lint / strict typecheck / test / build） |
| `main` CI                       | `workspace-check` + `real-postgres` 双绿                |

macOS 侧由 `pnpm local:acceptance` 在开发机本地执行：CI 只有 Linux runner，而 ADR-14 在
本阶段允许「本地开发/未公证测试包」。

## 3. 过程中查出的实质缺陷

这些是里程碑最有价值的产出——它们都曾经带着**全绿的测试套件**存在于 `main`：

1. **`business_date` 约束拒绝一切合法日期。** 迁移 0019 把正则写成 `'^\\d{4}-...'`，
   `standard_conforming_strings=on` 时 `\\d` 匹配的是字面反斜杠。结果是真实 PostgreSQL 上
   **每一次开单与收款都失败**。能出厂是因为订单/支付测试全用 capturing pool（断言 SQL 文本
   的 mock），**从没有任何测试通过生产路径写入过一条真实订单**。
2. **Electron 壳装着旧 SPA。** 柜台 UI 改动没有回灌构建产物，壳内缺整个柜台界面。
3. **全新安装开不了单。** 价目表无种子数据，而冻结的契约面只有价目查询没有写入命令——
   唯一途径是绕过应用直接写库。
4. **CI 分层遮蔽。** turbo 的 lint 跑在 test 之前，一个行数超标错误挡住了上面两个缺陷；
   「红灯报出来的那条」不等于全部。

## 4. 现在守着这些的门禁

- **`main` 分支保护**：required status checks = `workspace-check` + `real-postgres`，
  `strict` + `enforce_admins`。直推被拒（实测 GH006），一切走 PR。
- 两个 workflow 的 `pull_request` **不带 `paths` 过滤**——被 skip 的 required check 永远不
  报告，会把 PR 永久卡死。
- 真实 PG 门禁要求 **`# skipped` 为 0**，防止 PG 用例悄悄退化成跳过。
- 柜台工作日现在有三层回归网：服务端命令总线、浏览器、macOS 打包应用。

## 5. 明确未交付

- 云部署、跨设备同步、离线队列、offline grant、Primary lease
- Windows 打包与实机适配
- macOS 签名、公证与自动更新（当前是未签名未公证的本地测试包）
- 会员、通知、AI/BYOK、照片工作流、工厂协同、取送与营销
- 真实小票/水洗唛/不干胶硬件（模拟打印为首期形态）

按 ADR-14 §4，以上属第二、三阶段。

## 6. 建议的下一步

1. 把挂单/撤销、独立补缴、统计与交班也纳入浏览器 E2E——目前只有服务端覆盖，
   回归网在这几条上最薄。
2. 逐步替换 `createCapturingPool` 断言 SQL 文本的用例；那是 §3 第 1 条缺陷的成因，
   订单以外的模块仍在用。
