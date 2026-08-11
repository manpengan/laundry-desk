# hk-vps 阶段 1 发布结果（2026-08-11）

- 环境：**开发测试** hk-vps，<https://desk.manpengan.xyz>
- 结果：**PASS — ADR-37 阶段 1 已关闭**
- 发布候选：`7989206b3e9748b2a607687466ef2e0775ad528e`
- 发布前 marker：`ae9808ce1f3dc61535dbcc1cb89e618f0350ecf6`
- 迁移头：`0046_print_job_request_idempotency.sql`（46 条）
- 验收真源：[ADR-36 Web 产品收口验收记录](../superpowers/specs/2026-08-09-adr36-web-product-convergence-acceptance.md)
- 历史过程：[阶段 1 发布尝试记录](2026-08-10-stage1-release-attempts.md)

> 本结果只证明使用合成数据的 hk-vps 开发测试环境完成 Cloud Web 阶段 1，不等于生产 SaaS、
> 正式签名桌面发行或 XP-58 实体打印验收。本文及其后续 docs-only 合并不改变运行代码；
> hk-vps marker 继续绑定上面的发布候选，不因文档合并点前移而重复部署。

## 1. 精确发布身份

| 项                   | 证据                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修复 PR              | [#164](https://github.com/manpengan/laundry-desk/pull/164) 修复 JSONB 键序误判；[#165](https://github.com/manpengan/laundry-desk/pull/165) 修正 Cloud 浏览器读面验收 |
| PR #165 head         | `ce68c38d8662882378153aa14648f3d65462b899`                                                                                                                           |
| `main` 合并点 / 候选 | `7989206b3e9748b2a607687466ef2e0775ad528e`                                                                                                                           |
| 目标旧版本           | `ae9808ce1f3dc61535dbcc1cb89e618f0350ecf6`                                                                                                                           |
| 迁移身份             | `0046_print_job_request_idempotency.sql`                                                                                                                             |
| evidence 创建时间    | `2026-08-11T04:19:36.071Z`（台北时间 12:19:36）                                                                                                                      |

发布前本地工作树为空，`HEAD` 与 `origin/main` 都精确等于候选；远端 transition 为
`phase=stable`，live marker 精确等于目标旧版本。主机 Ed25519 指纹每次连接均核对为
`SHA256:Urp+pKpu/XD45nZlT+1tYJ5VYmV5X0fXStu+zmQjv4A`。

## 2. 候选门禁

两套主干工作流都由候选合并点的 `push` 触发，`headSha` 精确为发布候选：

| 门禁                                                                                                         | 结果                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [V2 Foundation #31457099792](https://github.com/manpengan/laundry-desk/actions/runs/31457099792)             | **success**；`workspace-check` 与 `runtime-app-macos` 均通过                                                            |
| [V2 PostgreSQL Integration #31457099795](https://github.com/manpengan/laundry-desk/actions/runs/31457099795) | **success**；生命周期/迁移、catalog、RLS、恢复演练、独立卷 commissioning、无跳过 Server 测试与真实 PG Playwright 均通过 |

PR head 的 `workspace-check`、`runtime-app-macos` 与 `real-postgres` 也全部通过；发布裁决只使用
上述精确 merge SHA 的主干结果，不用 PR-head 绿灯代替。

## 3. 两阶段发布结果

1. `prepare` 使用候选、旧 marker 与迁移头的完整身份执行成功，候选切换后进入
   `awaiting_external_verification`。
2. 父进程捕获 `prepare` 的 stdout 且不向操作者转发 token，只在内存中解析后作为
   `finalize` 参数；token 未写入项目文件，运行结束后本机
   `laundry-cloud-release-credentials-*` 临时目录为零。
3. `finalize` 返回
   `CLOUD_RELEASE_COMMITTED candidate_sha=7989206b3e9748b2a607687466ef2e0775ad528e`。
4. committed history 的 `verification_evidence_authoritative=true`；全量 history/evidence
   retention、文件绑定与摘要复核通过。回滚树、恢复点、controller、history 与 evidence 按
   运维手册保留，没有在发布后手工删除。

## 4. 公网验收证据

| 层             | run-id                                       | 结果                                                                                 |
| -------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| ADR-36 API     | `ADR36-20260811T041909981Z-b1e7b1ac`         | **15/15 PASS**；含 `reminder_history`、`safe_cleanup`、`session_logout` 与 `overall` |
| Cloud Chromium | `CLOUD-BROWSER-20260811T041932326Z-5790902a` | `test_status=PASS`、`test_count=1`、`retries=0`                                      |

浏览器逐项为 `configuration PASS`、`core_ui_subset PASS`、`session_logout PASS`、
`business_cleanup NOT_REQUIRED`、`standalone_completion NOT_AUTHORIZED`。它只证明登录后的工作台、
价目、欠款、生产、顾客、催取与账务读面可达，并确认零产品命令；完整业务写入、历史 fixture、
审计与清理由同一 release identity 下的 API evidence 证明，两层不互相冒充。

## 5. 发布后独立审计

| 项                   | 新鲜结果                                                                   |
| -------------------- | -------------------------------------------------------------------------- |
| transition           | `phase=stable`                                                             |
| live marker          | `7989206b3e9748b2a607687466ef2e0775ad528e`                                 |
| 数据库               | 46 条迁移；head `0046_print_job_request_idempotency.sql`                   |
| systemd              | `laundry-desk`、`postgresql`、`caddy`、`kb-web` 均 active；failed units 0  |
| 监听                 | Desk `127.0.0.1:8787`；PostgreSQL `127.0.0.1/[::1]:5432`；Caddy `*:80/443` |
| Desk health          | `{"ok":true,"data":{"status":"ready"}}`                                    |
| 公网 SPA / KB health | `200` / `200`                                                              |
| 权威证据             | committed、authoritative、retention valid；API 15/15、Browser PASS         |
| 本地清理             | release credential 临时目录 0                                              |

## 6. 结论

ADR-37 阶段 1 的 required CI、精确 marker/schema、可恢复两阶段发布、完整公网 HTTP 纵向、
只读 Cloud Chromium、合成 fixture 清理、服务/监听与同机 KB 健康均已闭环。下一交付阶段是
阶段 2「柜台可信性缺口」；其功能实现和新契约仍须独立设计、PR、真实 PostgreSQL、浏览器与
云端验收，不能复用本结果作为未来功能的通过证据。
