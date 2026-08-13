# hk-vps 阶段 3.2–4.5 发布结果（2026-08-13）

- 环境：**开发测试** hk-vps，<https://desk.manpengan.xyz>
- 结果：**PASS — ADR-37 阶段 3.2 至 4.5 的云端发布已闭环**
- 发布候选：`65bd8210c824037d4c871a46ce3eaf3e3dc1c314`
- 发布前 marker：`f276bdbf328ae20aba20c7985c690a63484afdca`
- 迁移头：`0048_catalog_governance.sql`（48 条）→ `0069_bounded_automation.sql`（69 条）
- 实现 PR：[#171](https://github.com/manpengan/laundry-desk/pull/171) – [#181](https://github.com/manpengan/laundry-desk/pull/181)
- 新增裁决：[ADR-40](../adr/2026-08-11-adr-40-cloud-owner-operations.md) – [ADR-63](../adr/2026-08-13-adr-63-bounded-automation.md)

> 本结果只证明使用合成数据的 hk-vps 开发测试环境完成 Cloud Web 阶段 3.2 至 4.5，不等于生产
> SaaS、正式签名桌面发行、XP-58 实体打印，也不等于真实短信/微信/AI provider 验收。

> **本文的性质**：与阶段 1、2、3.1 的发布结果不同，本文不是发布操作者的同步记录，而是发布
> 完成后依据 hk-vps 上 root-only 权威记录（release history、finalize evidence、marker、迁移账本、
> systemd 与健康探针）做的**事后复核重建**。所有身份、摘要与结果均来自这些记录或本次独立
> 只读复核，未从操作者记忆或终端回滚记录转述；本次复核未执行任何写操作。

## 1. 精确发布身份

| 项                   | 证据                                                                     |
| -------------------- | ------------------------------------------------------------------------ |
| `main` 合并点 / 候选 | `65bd8210c824037d4c871a46ce3eaf3e3dc1c314`（PR #181 合并点）             |
| 目标旧版本           | `f276bdbf328ae20aba20c7985c690a63484afdca`                               |
| 迁移身份             | `0048_catalog_governance.sql` → `0069_bounded_automation.sql`            |
| compatibility        | `compatibility_decision=unproven`；`old_code_compatible=false`            |
| transition 创建时间  | `2026-08-13T14:02:53.718Z`（台北时间 22:02:53）                          |
| 写门闩证明时间       | `2026-08-13T14:02:57.305Z`；`write_freeze_terminated_sessions=0`         |
| evidence 创建时间    | `2026-08-13T14:15:23.403Z`（台北时间 22:15:23）                          |
| committed 时间       | `2026-08-13T14:15:29.036Z`（台北时间 22:15:29）                          |
| 迁移前账本摘要       | 48 条 / `3162449a…ad6b2`                                                 |
| 迁移前 source catalog| `2b15ed36…df052`（与阶段 3.1 发布后 golden 摘要一致）                    |

`old_code_compatible=false` 与阶段 1–3.1 不同：本轮跨 21 条迁移，旧代码**未被证明**可在 0069
schema 上运行。回滚不能只做代码切换，必须走保留的 controller 与 pre-release dump。

## 2. 候选门禁

精确 merge SHA `65bd8210…c314` 的两套 `push` 工作流：

| 门禁                                                                                                          | 结果                              |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| [V2 Foundation #31705863621](https://github.com/manpengan/laundry-desk/actions/runs/31705863621)              | **success**                       |
| [V2 PostgreSQL Integration #31705863502](https://github.com/manpengan/laundry-desk/actions/runs/31705863502)   | **success**                       |

## 3. 首轮失败尝试与修复（`53b012c`）

本轮第一个候选是 PR #178 的合并点 `53b012c62ae0956ca58ef4cc1b8f46091c97d5b9`，两次尝试均已
回滚，两份 `rolled_back` history 完整保留：

| 尝试 | 创建                       | 终止                       | 终止 phase          | 已达深度                                                            |
| ---: | -------------------------- | -------------------------- | ------------------- | ------------------------------------------------------------------- |
|    1 | `2026-08-13T10:08:45.317Z` | `2026-08-13T10:08:47.248Z` | `staged`            | 未进入迁移（`pre_migration_count=null`）                            |
|    2 | `2026-08-13T10:15:24.115Z` | `2026-08-13T10:38:00.507Z` | `recovery_required` | 已过写门闩与迁移（`pre_migration_count=48`、`write_gate=released`） |

两次的 `verification_evidence_authoritative` 均为 `false`，即未取得权威外部验收即被回滚，符合
失败关闭设计。随后三个 PR 修复发布验收侧缺陷，再以新候选重新发布：

- [#179](https://github.com/manpengan/laundry-desk/pull/179) 修复会员折扣发布验收
- [#180](https://github.com/manpengan/laundry-desk/pull/180) 隔离订单财务会员定价
- [#181](https://github.com/manpengan/laundry-desk/pull/181) 修复顾客档案验收清理

失败产物 `/opt/laundry-desk.failed-53b012c62ae0956ca58ef4cc1b8f46091c97d5b9` 按保留设计仍在，
未删除。

## 4. 两阶段发布结果

1. `prepare` 以候选、旧 marker 与 0069 的完整身份执行；迁移前账本 48 条、head
   `0048_catalog_governance.sql`。
2. 写门闩在 `22:02:57` 完成证明，终止应用会话 0 个，最终 `write_gate_state=released`。
3. 影子库 `laundry_release_verify_b979bc49f333dd97d346b3d36c0eae0c` 完成恢复比对；
   pre-release dump 为 `pre-65bd8210…-b979bc49….dump`，SHA-256 `767573f1…429ee`。
4. 代码切换后 marker 于台北时间 `22:13:47` 落盘，迁移账本在 `22:14:05` 推进到 0069，
   `laundry-desk` 服务于 `22:14:06` 进入 active。
5. `finalize` 取得权威外部验收后于 `22:15:29` 提交；`verification_evidence_authoritative=true`，
   evidence SHA-256 `02a82f29…5814f`，controller SHA-256 `c808446e…4b0a8a`，归档 SHA-256
   `2355c36b…4c01db`。
6. 回滚树保留为
   `/opt/laundry-desk.rollback-f276bdbf…afdca-before-65bd8210…c314`。

## 5. 公网验收证据

两层证据由 `finalize` 在同一 release identity 下产出，绑定候选、旧 SHA、迁移头与 transition。

| 层             | run-id                                       | 结果                                            |
| -------------- | -------------------------------------------- | ----------------------------------------------- |
| ADR-36 API     | `ADR36-20260813T141444815Z-14770fe2`         | **19/19 journey PASS**，`overall=PASS`（schema v6） |
| Cloud Chromium | `CLOUD-BROWSER-20260813T141515380Z-b80bae46` | `test_status=PASS`、`test_count=1`、`retries=0`  |

API 19 条纵向逐项 PASS：`configuration`、`dual_admin_auth`、`owner_store_operations`、
`staff_credentials`、`accounting_baseline`、`catalog_price`、`synthetic_customer`、
`cash_order_fulfillment`、`member_benefits`、`customer_profile_policy`、
`notification_delivery_boundary`、`factory_handoff_boundary`、`member_lifecycle`、
`accounting_today_delta`、`order_finance`、`reporting_exports_shift`、`reminder_history`、
`safe_cleanup`、`session_logout`。

相对阶段 3.1 的 15 条，本轮新增 `owner_store_operations`、`member_benefits`、
`customer_profile_policy`、`notification_delivery_boundary`、`factory_handoff_boundary` 五条，
分别对应 ADR-40/41/42/44/45；`reminder_history` 由阶段 1 的 `BLOCKED` 转为 **PASS**。

浏览器逐项为 `configuration PASS`、`core_ui_subset PASS`、`session_logout PASS`、
`business_cleanup NOT_REQUIRED`、`standalone_completion NOT_AUTHORIZED`；用例标题为
`core_ui_subset: public Cloud Web read surfaces are reachable`。Browser 只证明公网读面与零产品
命令，完整写入与清理由同一 release identity 下的 API evidence 证明，两层不互相冒充。

## 6. 发布后独立复核（2026-08-13 22:24，只读）

| 项           | 新鲜结果                                                                    |
| ------------ | --------------------------------------------------------------------------- |
| transition   | `phase=stable`；无活动 transition                                           |
| live marker  | `65bd8210c824037d4c871a46ce3eaf3e3dc1c314`；`environment=hk-vps-cloud-test` |
| 仓库一致性   | `main=origin/main=65bd821`，工作树 clean，0 open PR                         |
| 部署树       | `/opt/laundry-desk` 下 69 份迁移，head `0069_bounded_automation.sql`         |
| 数据库       | `laundry_schema_migrations` 69 条，head 0069，应用于 `22:14:05`             |
| systemd      | `laundry-desk`、`postgresql`、`caddy`、`kb-web` 均 active；failed units 0    |
| 健康         | Desk loopback `8787` 200；Desk 公网 200；KB 公网 302                        |
| retention    | history 7；controller 7；backup 12；verification evidence 4                 |
| `/opt` 产物  | 7 个：1 live + 1 failed(`53b012c`) + 5 rollback                             |

## 7. 明确未取得

- **代码回滚兼容性未证明**：`old_code_compatible=false`。回滚必须使用保留的 controller 与
  pre-release dump，不能只切换 `/opt` 目录。
- **真实 provider 全部缺席**：AI/BYOK 切片中 provider adapter 的实际连接层因缺外部测试凭据被
  跳过，流式 runtime 为 deterministic fake；真实短信/微信保持
  `software_only` / `blocked_external_provider`。本轮 API 的
  `notification_delivery_boundary` 只证明边界失败关闭，不证明已发送或送达。
- **未做容量或生产性声明**：本环境只允许合成数据，不含真实顾客 PII，不等于生产 SaaS。
- **桌面与硬件门禁不变**：Windows、macOS 正式签名/公证、XP-58 实体出纸继续保持独立后置门禁。

## 8. 结论

阶段 3.2 至 4.5 的实现、PR、精确 merge-SHA 主干 CI、0048 → 0069 两阶段发布、公网
API 19/19 与 Cloud Chromium、marker/schema/服务/健康与保留证据均已闭环，`53b012c` 的两次失败
尝试与修复链完整留痕。仓库与 hk-vps 当前精确一致于 `65bd8210…c314`。

下一次发布前需注意：本轮之后代码回滚不再被证明兼容当前 schema，且 `/opt` 已有 7 个产物，
接近阶段 3.1 触发过的保留上限；应先按明确授权对 `53b012c` 失败产物做可恢复归档。
