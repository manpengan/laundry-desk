# ADR-37 阶段 3.1 价目治理验收记录

> 日期：2026-08-11
> 当前状态：**PASS — 本地、GitHub 与 hk-vps 开发测试闭环已通过**
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
| 管理列表含在架/停用、排序与版本 | 已通过   | 已通过   | Contracts + Server + Browser |
| 新增/改价/停用/启用乐观锁       | 已通过   | 已通过   | 真实 PG + API                |
| 完整在架快照原子排序            | 已通过   | 已通过   | 真实 PG + Browser            |
| catalog-only 安全审计           | 已通过   | 已通过   | 投影负例 + 真实 PG + Web     |
| 历史订单快照不变                | 已通过   | 已通过   | 订单回归 + API               |

## 3. 最终门禁

| 门禁            | 当前状态 | 关闭条件                                                    |
| --------------- | -------- | ----------------------------------------------------------- |
| 全仓质量        | 已通过   | `pnpm workspace:check` 新鲜全绿                             |
| 真实 PostgreSQL | 已通过   | 48 条迁移双跑、catalog 并发/审计/隔离回归全绿               |
| Browser         | 已通过   | 本地写纵向 + 公网只读 Cloud Chromium                        |
| GitHub          | 已通过   | PR required checks、合并、精确 merge-SHA 主干 CI            |
| hk-vps          | 已通过   | 0048 两阶段发布、golden catalog、API/marker/health/清理全绿 |

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

## 5. GitHub 与云端证据

- 实现 PR [#169](https://github.com/manpengan/laundry-desk/pull/169) 已合并；PR head
  `05a928e16a614ecdc02dadf045cebd1666a3a3ee` 的三项 required checks 全绿。
- 精确 merge SHA `f276bdbf328ae20aba20c7985c690a63484afdca` 的
  [V2 Foundation #31489636390](https://github.com/manpengan/laundry-desk/actions/runs/31489636390)与
  [V2 PostgreSQL Integration #31489636344](https://github.com/manpengan/laundry-desk/actions/runs/31489636344)
  均为 `push/main/success`。
- hk-vps 已从 marker `6f106076…3f47` / 0047 以同一父进程内存接力 token 完成
  `prepare → finalize`；当前 `phase=stable`，marker 精确为 `f276bdb…fdca`，数据库 48 条迁移、
  head `0048_catalog_governance.sql`。
- 发布后 golden catalog 为 678 entries / `2b15ed364041fdb454159c8706316888b16616e892ac856e9a419ed04e2df052`；
  `laundry_app` 的 catalog `DELETE=false`、`TRUNCATE=false`。
- ADR-36 API `ADR36-20260811T125802788Z-565ce627` 为 15/15 PASS；Cloud Chromium
  `CLOUD-BROWSER-20260811T125835362Z-70ab733f` 为 1/1 PASS、0 retry、零产品命令。
- API 纵向覆盖 CAS 冲突、停用/启用、排序、安全审计与历史价格快照；`safe_cleanup`、
  `session_logout` 均 PASS，本轮合成价目最终 active 0 / inactive 1。
- Desk/PostgreSQL/Caddy/KB 均 active、failed units 0；Desk 与 PostgreSQL 只监听既定
  loopback，公网 Desk/SPA/KB 均健康；本机 release 临时目录为 0。
- 保留槽位失败关闭、两项可恢复归档和完整发布证据见
  [阶段 3.1 发布结果](../../operations/2026-08-11-stage3-catalog-governance-release-result.md)。

## 6. 已知边界

- 本切片不新增批量改价、价目导入导出、促销、库存、供应商或生产 SaaS 能力。
- `0047 -> 0048` 是旧代码兼容扩展；失败回滚不自动降级数据库。
- 桌面正式发行、XP-58 实体打印与 Windows 适配仍按 ADR-37 后置。
