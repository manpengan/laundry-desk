# hk-vps 阶段 2 发布结果（2026-08-11）

- 环境：**开发测试** hk-vps，<https://desk.manpengan.xyz>
- 结果：**PASS — ADR-37 阶段 2 已关闭**
- 发布候选：`6f106076018940eec8fcc9e8c2cfb7842c323f47`
- 发布前 marker：`7989206b3e9748b2a607687466ef2e0775ad528e`
- 迁移头：`0047_cloud_counter_trust.sql`（47 条）
- 实现 PR：[#167](https://github.com/manpengan/laundry-desk/pull/167)
- 验收真源：[阶段 2 柜台可信性验收记录](../superpowers/specs/2026-08-11-stage2-counter-trust-acceptance.md)

> 本结果只证明使用合成数据的 hk-vps 开发测试环境完成 Cloud Web 阶段 2，不等于生产 SaaS、
> 正式签名桌面发行或 XP-58 实体打印验收。本文后续的 docs-only 合并不改变运行代码；部署
> marker 继续绑定上面的发布候选，不因文档合并点前移而重复部署。

## 1. 精确发布身份

| 项                   | 证据                                                |
| -------------------- | --------------------------------------------------- |
| PR #167 head         | `871657aefd1de1d288113b703155ad0f0d644866`          |
| `main` 合并点 / 候选 | `6f106076018940eec8fcc9e8c2cfb7842c323f47`          |
| 目标旧版本           | `7989206b3e9748b2a607687466ef2e0775ad528e`          |
| 迁移身份             | `0047_cloud_counter_trust.sql`                      |
| compatibility        | `ADR-38`；`0046 → 0047`；`old_code_compatible=true` |
| evidence 创建时间    | `2026-08-11T09:10:28.258Z`（台北时间 17:10:28）     |
| committed 时间       | `2026-08-11T09:10:33.919Z`（台北时间 17:10:33）     |

发布前本地工作树为空，`HEAD` 与 `origin/main` 都精确等于候选；远端 transition 为
`phase=stable`，live marker 精确等于目标旧版本。主机 Ed25519 指纹每次连接均核对为
`SHA256:Urp+pKpu/XD45nZlT+1tYJ5VYmV5X0fXStu+zmQjv4A`。

## 2. 候选门禁

PR head 的 `workspace-check`、`runtime-app-macos` 与 `real-postgres` 全部通过。发布裁决使用
精确 merge SHA 的两套 `push` 工作流，不以 PR-head 绿灯代替：

| 门禁                                                                                                         | 结果                                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| [V2 Foundation #31474079611](https://github.com/manpengan/laundry-desk/actions/runs/31474079611)             | **success**；`workspace-check` 与 `runtime-app-macos` 均通过；`headSha=6f106076…f47`                               |
| [V2 PostgreSQL Integration #31474079588](https://github.com/manpengan/laundry-desk/actions/runs/31474079588) | **success**；迁移/catalog/RLS/恢复演练、Server 无跳过真库测试与真实 PG Playwright 全部通过；`headSha=6f106076…f47` |

本地最终证据为 `pnpm workspace:check` 全绿；隔离 PostgreSQL 16 从空卷应用 47 条迁移并重复
reconcile，Server 848/848、0 skipped；Chromium 17/17。完整计数见阶段 2 验收记录。

## 3. 保留槽位失败关闭与可恢复归档

首次 `prepare` 在任何 transition 或迁移变更前返回
`CLOUD_RELEASE_HISTORY_RETENTION_LIMIT`。发布后只读复核确认远端仍是 `phase=stable`、旧 marker、
46 条迁移/head 0046，四项服务 active，公网 Desk/KB 健康；上传归档与本地临时目录均已清理。

活动保留集合当时为 8/8。经明确授权，选择最早的
`46bfc478c5e9864dff2cfcb47194bd1a1b18585f` rolled-back 记录：它非权威、无 backup、
无 verification evidence、无 `/opt` artifact。操作持有 release lock，校验 canonical history、
controller identity/摘要和 owner/mode 后，将 history 与绑定 controller 移入 root-only 可恢复归档：

- 归档：`/var/lib/laundry-desk-release-archive/46bfc478c5e9864dff2cfcb47194bd1a1b18585f-rolled-back`
- manifest SHA-256：`9e44b05d6ea34af0d8258c7ac5810805c97ee69c8c3810d8ee7cd29d0c013620`
- 活动 history/controller：`8/8 → 7/7`

首次归档演练因临时改名触发 controller basename 身份保护，脚本在提交前把两个原路径完整
回滚；复核 8 条 controller 全部 PASS、归档目录为空后，保留原 basename 重试成功。归档后的
history/controller/backup/evidence 全量 preflight 通过，未删除任何历史证据。最终发布提交后
活动 history/controller 回到 8/8，独立归档仍保持摘要可验证。

## 4. 两阶段发布结果

1. `prepare` 使用候选、旧 marker 与 0047 的完整身份执行成功；迁移前账本为 46 条、head
   `0046_print_job_request_idempotency.sql`，compatibility 裁决为 ADR-38。
2. 写门闩完成 `intent → active → released`，迁移窗口终止应用会话为 0；shadow restore、
   migration authority 与 golden catalog 均通过。迁移前 0046 source catalog 为 663 entries /
   `2d836d0c…3c5d`；shadow/迁移后 0047 catalog 为 676 entries / `172d1df5…5938`；cluster
   stable/write-frozen 摘要分别为 `911d17a2…1f92` / `24412b15…5e03`。
3. 父进程只在内存中接力 release token，不向操作者输出，也不写项目文件；`finalize` 返回
   `CLOUD_RELEASE_COMMITTED candidate_sha=6f106076018940eec8fcc9e8c2cfb7842c323f47`。
4. committed history 的 `verification_evidence_authoritative=true`；history/evidence/controller/
   backup retention 与摘要复核通过。回滚树和恢复点按运维手册保留，没有发布后手工删除。

## 5. 公网验收证据

| 层             | run-id                                       | 结果                                                                          |
| -------------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| ADR-36 API     | `ADR36-20260811T090948556Z-7c27943e`         | **15/15 PASS**；含完整业务纵向、`safe_cleanup`、`session_logout` 与 `overall` |
| Cloud Chromium | `CLOUD-BROWSER-20260811T091023299Z-ba8276ad` | `test_status=PASS`、`test_count=1`、`retries=0`                               |

浏览器逐项为 `configuration PASS`、`core_ui_subset PASS`、`session_logout PASS`、
`business_cleanup NOT_REQUIRED`、`standalone_completion NOT_AUTHORIZED`。Browser 只证明登录后的
公网核心读面与零产品命令；完整写入、双管理员、退款、fixture、审计与清理由同一 release identity
下的 API evidence 证明，两层不互相冒充。

## 6. 发布后独立审计

| 项                   | 新鲜结果                                                                            |
| -------------------- | ----------------------------------------------------------------------------------- |
| transition           | `phase=stable`                                                                      |
| live marker          | `6f106076018940eec8fcc9e8c2cfb7842c323f47`                                          |
| 数据库               | 47 条迁移；head `0047_cloud_counter_trust.sql`                                      |
| systemd              | `laundry-desk`、`postgresql`、`caddy`、`kb-web` 均 active；failed units 0           |
| 监听                 | Desk `127.0.0.1:8787`；PostgreSQL `127.0.0.1/[::1]:5432`；Caddy `*:80/443`          |
| Desk health          | loopback/public 均返回 `{"ok":true,"data":{"status":"ready"}}`                      |
| 公网 SPA / KB health | `200` / `200`                                                                       |
| 权威证据             | committed、authoritative、API 15/15、Browser PASS；evidence SHA-256 `2421bb3d…2518` |
| retention            | 活动 history/controller 8/8；backup entries 12；独立归档 manifest `9e44b05d…3620`   |
| 本地清理             | release credential 与 release 临时目录均为 0；仓库工作树 clean                      |

## 7. 结论

ADR-37 阶段 2 的三个顺序切片、完整本地/真实 PostgreSQL/Browser 门禁、PR 与 merge-SHA 主干 CI、
0047 可恢复两阶段发布、公网 API/Chromium、marker/schema、服务/监听、合成数据清理和保留证据均已
闭环。下一交付阶段是阶段 3「经营增强」；其四个切片仍须分别冻结 ADR、权限/隐私/金额口径并形成
独立真实 PG、Web、CI 与云端证据，不能复用本结果作为未来功能的通过证明。活动 retention 已重新
达到 8/8；下一次发布前必须再次按明确授权和精确身份归档，不得放宽上限或自动删除证据。
