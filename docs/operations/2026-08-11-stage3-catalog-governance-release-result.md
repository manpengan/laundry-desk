# hk-vps 阶段 3.1 价目治理发布结果（2026-08-11）

- 环境：**开发测试** hk-vps，<https://desk.manpengan.xyz>
- 结果：**PASS — ADR-37 阶段 3.1 已关闭**
- 发布候选：`f276bdbf328ae20aba20c7985c690a63484afdca`
- 发布前 marker：`6f106076018940eec8fcc9e8c2cfb7842c323f47`
- 迁移头：`0048_catalog_governance.sql`（48 条）
- 实现 PR：[#169](https://github.com/manpengan/laundry-desk/pull/169)
- 验收真源：[阶段 3.1 价目治理验收记录](../superpowers/specs/2026-08-11-stage3-catalog-governance-acceptance.md)

> 本结果只证明使用合成数据的 hk-vps 开发测试环境完成 Cloud Web 阶段 3.1，不等于生产
> SaaS、正式签名桌面发行或 XP-58 实体打印验收。本文后续的 docs-only 合并不改变运行代码；
> 部署 marker 继续绑定上面的发布候选，不因文档合并点前移而重复部署。

## 1. 精确发布身份

| 项                   | 证据                                                |
| -------------------- | --------------------------------------------------- |
| PR #169 head         | `05a928e16a614ecdc02dadf045cebd1666a3a3ee`          |
| `main` 合并点 / 候选 | `f276bdbf328ae20aba20c7985c690a63484afdca`          |
| 目标旧版本           | `6f106076018940eec8fcc9e8c2cfb7842c323f47`          |
| 迁移身份             | `0048_catalog_governance.sql`                       |
| compatibility        | `ADR-39`；`0047 → 0048`；`old_code_compatible=true` |
| transition 创建时间  | `2026-08-11T12:52:25.854Z`（台北时间 20:52:25）     |
| evidence 创建时间    | `2026-08-11T12:58:40.046Z`（台北时间 20:58:40）     |
| committed 时间       | `2026-08-11T12:58:45.973Z`（台北时间 20:58:45）     |

发布前本地工作树为空，`HEAD` 与 `origin/main` 都精确等于候选；远端 transition 为
`phase=stable`，live marker 精确等于目标旧版本。主机 Ed25519 指纹每次连接均核对为
`SHA256:Urp+pKpu/XD45nZlT+1tYJ5VYmV5X0fXStu+zmQjv4A`，SSH 继续固定专用 key、
`IdentitiesOnly=yes`，并关闭密码与 keyboard-interactive 认证。

## 2. 候选门禁

PR head 的 `workspace-check`、`runtime-app-macos` 与 `real-postgres` 全部通过。发布裁决使用
精确 merge SHA 的两套 `push` 工作流，不以 PR-head 绿灯代替：

| 门禁                                                                                                         | 结果                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [V2 Foundation #31489636390](https://github.com/manpengan/laundry-desk/actions/runs/31489636390)             | **success**；`workspace-check` 与 `runtime-app-macos` 通过；`headSha=f276bdbf…fdca`                     |
| [V2 PostgreSQL Integration #31489636344](https://github.com/manpengan/laundry-desk/actions/runs/31489636344) | **success**；迁移/catalog/RLS/恢复、Server 无跳过真库测试与真实 PG Playwright 通过；`headSha=f276…fdca` |

本地最终证据为 `pnpm workspace:check` 全绿；Contracts 763/763、DB 70/70、Server 真实
PostgreSQL 853/853、0 skipped，本地 Chromium 17/17。独立 PostgreSQL 16 从 0047 升到
0048，发布 catalog 探针为 678 entries / `2b15ed36…052`。

## 3. 保留槽位失败关闭与可恢复归档

发布前活动 history/controller 为 8/8。经授权先选择无 backup、无 evidence、无 `/opt`
artifact 的 `f1d7104dab5030524be3daf6c8059f51104bf841` rolled-back 记录，将绑定 history 与
controller 移入 root-only 可恢复归档；活动集合变为 7/7，manifest SHA-256 为
`dc578599717afd3a3181ea7198e3c9938759c9a6be66379984fab0e7b55671c6`。

首次 `prepare` 随后在任何 transition、迁移或代码切换前返回
`CLOUD_RELEASE_ARTIFACT_RETENTION_LIMIT`。稳定态有 6 个 `/opt/laundry-desk.*` 产物，而上传
incoming 与建立 next 目录会使预检峰值达到 8；门禁按设计失败关闭并自动清除两项临时产物。
失败后仍是旧 marker、47/head 0047，服务与公网健康。

经再次明确授权，选择最早的
`laundry-desk.failed-1a588e791d269cc1153b243776b56f137b130b45`：其 history 为
rolled-back、非权威、无 verification evidence，且另有已验证 backup。操作持有 release lock，
校验 marker、history 身份、owner/mode、同文件系统与目标不存在后，原子移入：

- 归档：`/var/lib/laundry-desk-release-archive/1a588e791d269cc1153b243776b56f137b130b45-rolled-back-failed-artifact`
- 条目 / 总字节：`56,156` / `880,062,958`
- tree manifest SHA-256：`87cb21d52b38125fd083a4d23ee4095a530c07e77a321315f1c1f1845675a7f7`
- archive manifest SHA-256：`bc8136c79148d4606ea2d831d94a2ea7d6ca09353b54171122dd762b35e88a65`
- 活动 `/opt` 产物：`6 → 5`

归档后全量发布 preflight 通过。两个归档都可恢复，未删除 history、controller、backup 或
verification evidence，也未放宽保留上限。

## 4. 两阶段发布结果

1. `prepare` 使用候选、旧 marker 与 0048 的完整身份执行成功；迁移前账本为 47 条、head
   `0047_cloud_counter_trust.sql`，compatibility 裁决为 ADR-39。
2. 写门闩完成 `intent → active → released`，迁移窗口终止应用会话为 0；shadow restore、
   migration authority 与 golden catalog 均通过。迁移前 0047 source catalog SHA-256 为
   `172d1df5…5938`；迁移后 0048 为 678 entries / `2b15ed36…052`，stable cluster 为
   8 entries / `911d17a2…1f92`。
3. 同一父进程只在内存中接力 release token，不向操作者输出，也不写项目文件；`finalize`
   成功提交候选。
4. committed history 的 `verification_evidence_authoritative=true`；history/evidence/controller/
   backup retention 与摘要复核通过。回滚树和恢复点按运维手册保留，没有发布后手工删除。

## 5. 公网验收证据

| 层             | run-id                                       | 结果                                                                |
| -------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| ADR-36 API     | `ADR36-20260811T125802788Z-565ce627`         | **15/15 PASS**；含价目 CAS/启停/排序/审计、订单价格快照、清理与注销 |
| Cloud Chromium | `CLOUD-BROWSER-20260811T125835362Z-70ab733f` | `test_status=PASS`、`test_count=1`、`retries=0`                     |

API 的 `catalog_price` 证明新建、陈旧版本拒绝、停用、重新启用、完整在架快照排序与五字段安全
审计；`order_finance` 证明开单后改价不重估历史订单快照。`safe_cleanup` 与
`session_logout` 均 PASS；本轮合成价目最终为 active 0 / inactive 1，符合只软下架约束。

浏览器逐项为 `configuration PASS`、`core_ui_subset PASS`、`session_logout PASS`、
`business_cleanup NOT_REQUIRED`、`standalone_completion NOT_AUTHORIZED`。Browser 只证明公网
读面与零产品命令；完整写入与清理由同一 release identity 下的 API evidence 证明，两层不互相
冒充。

## 6. 发布后独立审计

| 项           | 新鲜结果                                                                   |
| ------------ | -------------------------------------------------------------------------- |
| transition   | `phase=stable`；无活动 `transition.json`                                   |
| live marker  | `f276bdbf328ae20aba20c7985c690a63484afdca`                                 |
| 数据库       | 48 条迁移；head `0048_catalog_governance.sql`；PostgreSQL 16               |
| catalog 权限 | `laundry_app` 的 `DELETE=false`、`TRUNCATE=false`                          |
| systemd      | `laundry-desk`、`postgresql`、`caddy`、`kb-web` 均 active；failed units 0  |
| 监听         | Desk `127.0.0.1:8787`；PostgreSQL `127.0.0.1/[::1]:5432`；Caddy `*:80/443` |
| Desk / KB    | Desk loopback/public ready，公网 SPA 200；KB loopback/public `ok`          |
| 权威证据     | committed、authoritative；evidence SHA-256 `5be5f46d…8798`                 |
| retention    | history/controller 8/8；backup entries 14；evidence 3；活动 `/opt` 产物 6  |
| 本地清理     | release credential 与 release 临时目录均为 0；发布结束时仓库工作树 clean   |

## 7. 结论

ADR-37 阶段 3.1 的 ADR、实现、本地/真实 PostgreSQL/Browser 门禁、PR 与精确 merge-SHA 主干
CI、0048 可恢复两阶段发布、公网 API/Chromium、marker/schema、catalog golden、权限、服务与
清理证据均已闭环。阶段 3 仍在进行中；下一顺序切片是 3.2「Owner 公网经营与门店管理」，必须另立
ADR、权限/隐私边界、真实 PG、Web、CI 与云端证据。活动 history/controller 已回到 8/8；下一次
发布前仍须按明确授权和精确身份做可恢复归档，不得自动删除或放宽上限。
