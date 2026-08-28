# 阶段 5.0 发布解阻与关闭结果（2026-08-25）

- 环境：**开发测试** hk-vps，<https://desk.manpengan.xyz>
- 结果：**PASS**（留存解阻、精确主干发布、发布后 preflight 与健康复核全部通过）
- 发布候选：`c8919af3c666cf70df2fbf04645ebdf0f377f35a`
- 发布前 marker：`b9ddacc9ae85551ce6b66f7da9f1dd7811d3e6ca`
- 迁移头：`0069_bounded_automation.sql`（69 条，发布前后一致）
- 裁决：[ADR-64](../adr/2026-08-17-adr-64-stage5-productionization-and-release-retention.md)
- 后继：[ADR-65](../adr/2026-08-25-adr-65-cloud-production-baseline.md)与
  [阶段 5.1 计划](../superpowers/plans/2026-08-25-stage51-cloud-production-baseline-plan.md)

> 本结果只关闭阶段 5.0 的发布连续性与留存门禁。hk-vps 继续只承载合成数据；本结果不等于
> 生产 SaaS、真实顾客 PII 获准、离机数据保护、告警送达、生产容量、真实 provider、正式桌面
> 发行或实体硬件验收。

## 1. 精确候选与主干门禁

发布机工作树在动作前为 clean `main`，且 `HEAD == origin/main == c8919af3…f35a`。候选最新
required checks 与同 SHA 的附加 macOS 门禁均为绿灯：

| 门禁                                                                                                      | 结果        |
| --------------------------------------------------------------------------------------------------------- | ----------- |
| [`workspace-check`](https://github.com/manpengan/laundry-desk/actions/runs/32651327525/job/97223291255)   | **success** |
| [`real-postgres`](https://github.com/manpengan/laundry-desk/actions/runs/32651327515/job/97223291271)     | **success** |
| [`runtime-app-macos`](https://github.com/manpengan/laundry-desk/actions/runs/32651327525/job/97223291432) | **success** |

固定 SSH authority 复核为 `root@103.233.252.201:22`、专用 Ed25519 identity、key-only、batch、
strict host checking；现场主机 Ed25519 fingerprint 精确等于仓库运维权威固定值。发布期间未降低
认证或主机密钥校验，也未产生服务器私有补丁。

## 2. 留存解阻

初始稳定态为 `/opt` 常驻 6 棵、history/controller/backup 各 8 组、evidence 7 组；下一次
prepare 会因 `/opt` 峰值和 history/backup 上限失败关闭。全部移动均由阶段 5.0 root-only 工具在
同一 release lock、无活动 transition 下执行，只做同文件系统可逆 rename，未删除对象，也未输出
原 release token。

| 顺序 | 精确对象                                                                                                                                            | 动作与结果                                                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `laundry-desk.rollback-7989206b3e9748b2a607687466ef2e0775ad528e-before-6f106076018940eec8fcc9e8c2cfb7842c323f47`                                    | superseded rollback 退役；`entries=56158`、`bytes=907416212`、`ino=1235249`，移动前后 inode 不变                                                                                                       |
| 2    | candidate `7989206b3e9748b2a607687466ef2e0775ad528e`，token SHA-256 `5c851e87e8d69816c4cbe62b3f6e55a1db76533d3448594e7782b877372648a8`，`committed` | manifest-bound release set 归档，`items=5`                                                                                                                                                             |
| 3    | candidate `c8919af3c666cf70df2fbf04645ebdf0f377f35a` 的第一次 transition                                                                            | prepare 停在 `recovery_required`；按精确 identity 受控回滚到旧 live，随后把非权威 `rolled_back` set（token SHA-256 `f7c069a3c99c23159596291a580be72a7fa2ca4033d3afb88ffc0454dea5d264`）归档，`items=2` |
| 4    | `laundry-desk.rollback-6f106076018940eec8fcc9e8c2cfb7842c323f47-before-f276bdbf328ae20aba20c7985c690a63484afdca`                                    | superseded rollback 退役；`entries=56287`、`bytes=908677386`、`ino=1106591`，移动前后 inode 不变                                                                                                       |
| 5    | candidate `6f106076018940eec8fcc9e8c2cfb7842c323f47`，token SHA-256 `7f810553e7fb76950b8b936c33c257f35b1ab5f3d972013f8a54c9a827f11f94`，`committed` | manifest-bound release set 归档，`items=5`                                                                                                                                                             |

解阻后为 `/opt 4`、history/controller/backup 各 6、evidence 5；active 集合重新通过严格绑定校验，
独立 `preflight` 返回 room 全部为 `true`。归档根仍为 root-only，完整 release set 可按其 manifest
显式 restore；本轮没有执行远端 restore，也不把 same-inode 可逆性冒充实际恢复。

## 3. 受保护发布与失败关闭

第二条 transition 的 prepare 于 `2026-08-25T08:32:40.437Z` 建立并成功停在
`awaiting_external_verification`。第一次 finalize 调用的远端 API 与候选健康面正常，但发布机缺少
Playwright `1.61.1` 所需的 Chromium headless-shell revision `1228`，因此以
`CLOUD_RELEASE_BROWSER_EVIDENCE_NOT_PASSED` 失败关闭；transition、候选 live 和一次性 identity
均被保留，没有伪造或跳过 UI 证据。

发布机随后通过锁定 CLI 补齐 revision `1228` 并独立证明 Chromium 可启动，再对**同一** transition
重试 finalize。工具重新运行新鲜 API 与浏览器子进程、持久化 authoritative evidence，并于
`2026-08-25T08:52:13.847Z` 返回：

```text
CLOUD_RELEASE_ORCHESTRATION_COMMITTED candidate_sha=c8919af3c666cf70df2fbf04645ebdf0f377f35a migration_head=0069_bounded_automation.sql
```

本轮为同迁移代码切换：`compatibility_decision=same_migration`、`old_code_compatible=true`、
`write_gate_state=released`，停写窗口终止的既有应用会话为 0。

## 4. 新鲜验收证据

| 层                                           | 新鲜证据                                                                              | 结果                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------- |
| transition                                   | verification id `5bf43962-cbb7-4890-810e-63ecbec3695e`；evidence 摘要 `56aa3ebbae02…` | `committed`、`authoritative=true`               |
| ADR-36 API                                   | `ADR36-20260825T085056964Z-fe1b971d`                                                  | **20/20 PASS**，非 PASS 为 0                    |
| Cloud Chromium                               | `CLOUD-BROWSER-20260825T085151546Z-05d0637d`                                          | `test_status=PASS`、`test_count=1`、`retries=0` |
| 发布工件 / controller / database-only 恢复点 | `728d8cf88d3b…` / `647d15bf07b8…` / `efbb930619bd…`                                   | 摘要与 committed history 绑定                   |

浏览器结果为 `configuration PASS`、`core_ui_subset PASS`、`session_logout PASS`、
`business_cleanup NOT_REQUIRED`、`standalone_completion NOT_AUTHORIZED`。Browser 只证明公网只读面；
完整写入、催取历史 fixture 与清理由同一 release identity 下的 API 20/20 证据负责。

## 5. 发布后独立复核

| 项                  | 新鲜结果                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| transition / marker | `phase=stable`；live marker 精确为 `c8919af3c666cf70df2fbf04645ebdf0f377f35a`；环境仍为 `hk-vps-cloud-test`                   |
| 数据库              | `laundry_schema_migrations=69`，head `0069_bounded_automation.sql`；`laundry_app LOGIN=true`                                  |
| systemd             | `laundry-desk`、PostgreSQL、Caddy、`kb-web` 均 active；failed units 0                                                         |
| 监听                | Desk `127.0.0.1:8787`、PostgreSQL `127.0.0.1/[::1]:5432`、KB `127.0.0.1:8700`，均为 loopback                                  |
| HTTP                | Desk loopback `/health`、Desk 公网 `/health` 与 SPA `/`、KB loopback/public `/healthz` 均 200                                 |
| retention           | `/opt=5`、history/controller/backup `=7/7/7`、evidence `=6`；四类 active 绑定有效                                             |
| 独立 preflight      | `opt_prepare_peak=7`；`artifact_room=true`、`history_room=true`、`backup_room=true`；两个受检文件系统可用 `13530218496` bytes |

## 6. 阶段 5.0 关闭裁决

ADR-64 §5 的治理一致性、归档/恢复与失败路径回归、全量主干门禁、精确主干上线、单独授权的远端
归档、稳定态健康、四类绑定余量和独立 preflight 条件均已取得证据。阶段 5.0 因此于
**2026-08-25 关闭**，下一活动切片转为阶段 5.1 的 Cloud 生产基线裁决与执行准备。

阶段 5.1 仍须取得真实独立环境、真实离机介质、联合恢复、容量和告警送达证据；在其关闭且另行
授权真实数据前，hk-vps 与任何生产候选均不得承载真实顾客 PII。
