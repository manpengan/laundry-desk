# hk-vps 非部署批次与白屏修复发布结果（2026-08-14）

- 环境：**开发测试** hk-vps，<https://desk.manpengan.xyz>
- 结果：**PASS**
- 发布候选：`b80ab3e1af8145f7c49b6767a87dcbf89079e1ec`
- 发布前 marker：`65bd8210c824037d4c871a46ce3eaf3e3dc1c314`
- 迁移头：`0069_bounded_automation.sql`（69 条，**发布前后一致**）
- 覆盖 PR：[#182](https://github.com/manpengan/laundry-desk/pull/182) – [#191](https://github.com/manpengan/laundry-desk/pull/191)、[#194](https://github.com/manpengan/laundry-desk/pull/194)

> 本结果只证明使用合成数据的 hk-vps 开发测试环境完成本轮发布，不等于生产 SaaS、正式签名桌面
> 发行、XP-58 实体打印，也不等于真实短信/微信/AI provider 验收。

本轮是 [非部署就绪度复核](2026-08-14-nondeploy-readiness-review.md) 记录的七个软件批次首次上线。
该复核明确要求「用户重新授权前不部署 hk-vps」；发布前已取得用户明确授权。

## 1. 精确发布身份

| 项                   | 证据                                                             |
| -------------------- | ---------------------------------------------------------------- |
| `main` 合并点 / 候选 | `b80ab3e1af8145f7c49b6767a87dcbf89079e1ec`（PR #194 合并点）     |
| 目标旧版本           | `65bd8210c824037d4c871a46ce3eaf3e3dc1c314`                       |
| 迁移身份             | `0069_bounded_automation.sql`（69 条），发布前后不变             |
| compatibility        | `compatibility_decision=same_migration`；`old_code_compatible=true` |
| transition 创建时间  | `2026-08-14T10:30:28.633Z`（台北时间 18:30:28）                  |
| 写门闩证明时间       | `2026-08-14T10:30:31.963Z`；`write_freeze_terminated_sessions=0` |
| evidence 创建时间    | `2026-08-14T10:41:23.877Z`（台北时间 18:41:23）                  |
| committed 时间       | `2026-08-14T10:41:29.815Z`（台北时间 18:41:29）                  |
| 迁移前账本摘要       | 69 条 / `97d42a78…72744`                                         |
| 迁移前 source catalog| `fec12c68…eae9a`                                                 |

**与上一轮的关键差别**：本轮没有 schema 变更，`compatibility_decision` 为 `same_migration`、
`old_code_compatible=true`。阶段 3.2–4.5 那轮跨 21 条迁移、旧代码兼容性 `unproven`，代码回滚
必须走 controller 与 dump；本轮的代码回滚是被证明可行的。

## 2. 候选门禁

精确 merge SHA `b80ab3e1…9e1ec` 的两套 `push` 工作流：

| 门禁                                                                                                        | 结果        |
| ----------------------------------------------------------------------------------------------------------- | ----------- |
| [V2 Foundation #31788892210](https://github.com/manpengan/laundry-desk/actions/runs/31788892210)            | **success** |
| [V2 PostgreSQL Integration #31788892215](https://github.com/manpengan/laundry-desk/actions/runs/31788892215) | **success** |

发布前逐项只读核对：`HEAD` 与 `origin/main` 精确等于候选、工作树 0 变更、live marker 精确等于
目标旧版本、库内账本 69 条与仓库迁移清单一致、无活动 transition、`phase=stable`、`/opt` 产物 5 个
（峰值 7 < 上限 8）、`/` 可用 17 GiB、KB loopback 与公网 `/healthz` 均 200、四个 systemd unit
active 且 failed 为 0、SSH 固定 root/IP/22/专用 identity 并禁用密码与交互认证。

## 3. 发布内容

| PR              | 内容                                                     |
| --------------- | -------------------------------------------------------- |
| #182            | 阶段 3.2–4.5 发布结果回写                                |
| #183            | 消除 `nanoid` high advisory                              |
| #184            | 路由级拆包并锁定生产 bundle 预算                         |
| #185            | 补强 PostgreSQL 影子恢复演练                             |
| #186            | 固化脱敏 V1 SQLite 迁移演练                              |
| #187            | 退役产物可恢复归档工具与归档结果回写                     |
| #188            | 固化 release candidate 组装与 SPA 保留 dry-run           |
| #189            | macOS CI 未签名 `.app` 构建与隔离 smoke                  |
| #190            | 通知 adapter 声明与 AI provider smoke 失败关闭           |
| #191            | 非部署就绪度复核                                         |
| #194            | 修复懒加载失败导致的白屏（issue #192、#193）             |

其中 #194 修复的是 #184 拆包引入的两条回归：host 入口 `void start()` 吞掉动态导入拒绝导致整页
空白，以及懒加载路由只有 `Suspense` 而无 ErrorBoundary，单个 chunk 失败会卸载整个根节点。两者
在本轮之前从未上线过，因此线上未曾暴露。

## 4. 两阶段发布结果

1. `prepare` 以候选、旧 marker 与 0069 的完整身份执行，18:29:47 起、10 分 48 秒完成。
2. 写门闩在 `18:30:31` 完成证明，终止应用会话 0 个，最终 `write_gate_state=released`；
   `app_role_original_can_login=true`。
3. 影子库 `laundry_release_verify_0a78578d3da5a55d8d6e59787d64ff72` 完成恢复比对；pre-release
   dump 为 `pre-b80ab3e1…-0a78578d….dump`，SHA-256 `56c73e35…f52c8`。
4. 迁移窗口为空操作：候选迁移清单与库内账本同为 69 条 / head `0069`。
5. `finalize` 取得权威外部验收后于 `18:41:29` 提交；`verification_evidence_authoritative=true`，
   evidence SHA-256 `9bd8278b…0c09d`，controller SHA-256 `5bee8519…1c562b`，归档 SHA-256
   `3667b01f…1ea5fe`。
6. 回滚树保留为 `/opt/laundry-desk.rollback-65bd8210…c314-before-b80ab3e1…9e1ec`。

release token 只在单个本地进程的内存中从 `prepare` 接力到 `finalize`，不写入任何本机文件，也未
出现在输出中。

## 5. 公网验收证据

| 层             | run-id                                       | 结果                                            |
| -------------- | -------------------------------------------- | ----------------------------------------------- |
| ADR-36 API     | `ADR36-20260814T104043435Z-30917698`         | **20/20 全 PASS**，非 PASS 为 0                 |
| Cloud Chromium | `CLOUD-BROWSER-20260814T104112097Z-8187f29e` | `test_status=PASS`、`test_count=1`、`retries=0` |

浏览器逐项为 `configuration PASS`、`core_ui_subset PASS`、`session_logout PASS`、
`business_cleanup NOT_REQUIRED`、`standalone_completion NOT_AUTHORIZED`。Browser 只证明公网读面
与零产品命令，完整写入与清理由同一 release identity 下的 API evidence 证明，两层不互相冒充。

## 6. 发布后独立复核（2026-08-14 18:4x，只读）

| 项          | 新鲜结果                                                                    |
| ----------- | --------------------------------------------------------------------------- |
| transition  | `phase=stable`；无活动 transition                                           |
| live marker | `b80ab3e1af8145f7c49b6767a87dcbf89079e1ec`；`environment=hk-vps-cloud-test` |
| 仓库一致性  | `main=origin/main=b80ab3e`，工作树 clean，0 open PR                         |
| 数据库      | `laundry_schema_migrations` 69 条，head `0069_bounded_automation.sql`        |
| systemd     | `laundry-desk`、`postgresql`、`caddy`、`kb-web` 均 active；failed units 0    |
| 健康        | Desk loopback 200；Desk 公网 200；KB 公网 `/healthz` 200                    |
| retention   | history 8；controller 8；backup 14                                          |
| `/opt` 产物 | 6 个：1 live + 5 rollback                                                   |

## 7. 归档工具首次真机可用

[退役产物归档工具](2026-08-09-hk-vps-cloud-test.md) 随 `tools/cloud/` 进入本次发布产物，这是它
第一次具备部署态可用条件。发布后从真实部署位置执行只读列举：

```
CLOUD_RELEASE_ARTIFACT_ARCHIVE_LIST count=0    exit=0
```

`count=0` 是正确结果：当前 6 个产物中，5 个回滚树绑定 `committed` history 记录，1 个
`rollback-pre-*` 不匹配退役产物名，没有一个满足「history 证明为 `rolled_back` 且
`verification_evidence_authoritative=false`」的归档条件。此前该工具只有 13 项本地回归，现已在
真实 `/opt` 与真实 history 上给出正确判断。

## 8. 下一次发布前的已知阻塞

`/opt` 产物由 5 增至 **6**，预检峰值回到 `6 + incoming + next = 8`，等于
`MAX_RETAINED_RELEASES`。**下一次 `prepare` 必然以 `CLOUD_RELEASE_ARTIFACT_RETENTION_LIMIT`
失败关闭。**

但归档工具当前对这 6 个产物全部拒绝（见 §7），因为可腾出的只剩绑定 `committed` 记录的旧回滚
树，而工具按设计拒绝这类 —— 这是有意的安全边界，不是缺陷。腾出槽位需要：

1. 显式决定退役哪一个非最新的 `committed` 回滚树；
2. 为工具增加一条经明确授权、绑定精确身份的受控路径，或按当轮授权手工归档。

在此之前不应尝试发布。

## 9. 明确未取得

- 真实短信/微信与 AI provider 仍为 `software_only` / `blocked_external_provider`；本轮 API 的
  通知与 AI 相关纵向只证明边界失败关闭，不证明已发送、已送达或已产生真实模型调用。
- 离机备份 authority、恢复介质与告警链仍是 `blocked_external_offsite`；同机 shadow drill 不能替代。
- 本环境只允许合成数据，不含真实顾客 PII，不等于生产 SaaS。
- Windows、macOS 正式签名/公证、XP-58 实体出纸继续按 ADR-37 后置。
