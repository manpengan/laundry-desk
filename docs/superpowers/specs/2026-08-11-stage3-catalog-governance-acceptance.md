# ADR-37 阶段 3.1 价目治理验收记录

> 日期：2026-08-11
> 当前状态：**LOCAL VERIFIED — 本地完整门禁已通过，GitHub 与云端关闭待执行**
> 决策：[ADR-39](../../adr/2026-08-11-adr-39-catalog-governance.md)
> 执行计划：[Cloud Web-first 1–4 交付计划](../plans/2026-08-10-post-adr36-delivery-plan.md)
> 云环境边界：[ADR-36](../../adr/2026-08-09-adr-36-cloud-test-environment.md)

## 1. 验收边界

- 代码、真实 PostgreSQL、Browser、GitHub CI、远端迁移与公网只读浏览器分别取证；互不代替。
- 历史订单价格快照只做回归，不允许目录更新触发历史账务重估。
- 云端只写合成 fixture；审计响应不得包含原始 before/after JSON、密码、PIN、token 或 cookie。

## 2. 行为矩阵

| 行为                            | 本地状态 | 云端状态 | 关闭证据                     |
| ------------------------------- | -------- | -------- | ---------------------------- |
| 管理列表含在架/停用、排序与版本 | 已通过   | 待发布   | Contracts + Server + Browser |
| 新增/改价/停用/启用乐观锁       | 已通过   | 待发布   | 真实 PG + API                |
| 完整在架快照原子排序            | 已通过   | 待发布   | 真实 PG + Browser            |
| catalog-only 安全审计           | 已通过   | 待发布   | 投影负例 + 真实 PG + Web     |
| 历史订单快照不变                | 已通过   | 待发布   | 订单回归 + API               |

## 3. 最终门禁

| 门禁            | 当前状态 | 关闭条件                                                    |
| --------------- | -------- | ----------------------------------------------------------- |
| 全仓质量        | 已通过   | `pnpm workspace:check` 新鲜全绿                             |
| 真实 PostgreSQL | 已通过   | 48 条迁移双跑、catalog 并发/审计/隔离回归全绿               |
| Browser         | 本地通过 | 本地写纵向 + 公网只读 Cloud Chromium                        |
| GitHub          | 待执行   | PR required checks、合并、精确 merge-SHA 主干 CI            |
| hk-vps          | 待执行   | 0048 两阶段发布、golden catalog、API/marker/health/清理全绿 |

## 4. 本地证据

- `pnpm workspace:check`：exit 0；format、lint、typecheck、全部 workspace 测试、
  Cloud 196/196 与 9/9 build 全绿。
- Contracts 763/763，DB 70/70；冻结目录为 43 commands / 29 queries，新管理面未进入
  AI 只读投影。
- 独立 PostgreSQL 16 从 0047 升到 0048；catalog golden evidence 为 678 entries，
  SHA-256 `2b15ed364041fdb454159c8706316888b16616e892ac856e9a419ed04e2df052`。
- 完整 Server 真实 PostgreSQL 套件 853/853、0 failed、0 skipped；catalog handler 定向
  5/5，目录真实 PG 定向 1/1。
- 本地 Chromium 17/17；柜台纵向覆盖新建、陈旧版本拒绝、停用、重新启用、上下排序、
  catalog 审计与历史订单价格快照不变。
- Edge SPA 已同步为内容寻址 bundle，`SPA_CHECK_OK entries=3`。

上述结果只关闭本地层。当前 live marker 仍是阶段 2 的
`6f106076018940eec8fcc9e8c2cfb7842c323f47` / 0047；不得把本地绿灯写成 0048 已部署。

## 5. 已知边界

- 本切片不新增批量改价、价目导入导出、促销、库存、供应商或生产 SaaS 能力。
- `0047 -> 0048` 是旧代码兼容扩展；失败回滚不自动降级数据库。
- 桌面正式发行、XP-58 实体打印与 Windows 适配仍按 ADR-37 后置。
