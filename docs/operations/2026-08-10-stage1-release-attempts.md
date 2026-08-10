# hk-vps 阶段 1 发布尝试记录（2026-08-10）

- 环境：**开发测试** hk-vps，<https://desk.manpengan.xyz>
- 裁决：[ADR-37](../adr/2026-08-10-adr-37-cloud-web-primary-delivery.md) · [ADR-36](../adr/2026-08-09-adr-36-cloud-test-environment.md)
- 计划：[Cloud Web-first 1–4 交付计划](../superpowers/plans/2026-08-10-post-adr36-delivery-plan.md)
- 操作流程：[hk-vps 云测试环境运维手册](2026-08-09-hk-vps-cloud-test.md)

> **本文是尝试记录，不是发布证据。** 阶段 1 **未关闭**：`prepare` 已把候选代码与 schema
> 切换上线，但 `finalize` 的外部验证未通过，transition 停在 `awaiting_external_verification`
> 且 `outcome=null`。发布**结果**证据必须在阶段 1 真正关闭时按运维手册另行记录。

## 1. 为什么单独记录

两阶段发布入口（`pnpm cloud:release:hk`）由 [#156](https://github.com/manpengan/laundry-desk/pull/156)
建立后，本日首次对真实 hk-vps 执行。首次执行连续暴露五个只有真连主机才会出现的事实：
前四个是环境事实，均以定点修复收敛；第五个是产品缺陷，尚未修复，见 §5.5。这些根因不体现在
任何单个 PR 的 diff 里，散落在多个 PR 正文与一次人工诊断中，因此单独归档。

## 2. 基线与实际部署

| 项                    | 值                                                            |
| --------------------- | ------------------------------------------------------------- |
| 本轮起始 `main`       | `6609c5e`（08-10 05:22）                                      |
| 本轮结束 `main`       | `a832bbd`（08-10 22:57，#162 合并点）                         |
| 首个部署尝试候选      | `f1d7104`（#157 合并点，未成功）                              |
| **实际部署候选**      | **`a832bbdc5a0ced37be99a9057eab70edbbf5be01`**                |
| 部署前 release marker | `ae9808ce1f3dc61535dbcc1cb89e618f0350ecf6`（实测）            |
| 部署前 migration head | `0045`                                                        |
| 部署后 release marker | **`a832bbd…be01`（实测，已切换）**                            |
| 部署后 migration head | **`0046_print_job_request_idempotency.sql`（46 条，已迁移）** |

## 3. 发布入口形状

`tools/cloud/hk-vps-release.mjs` 提供四个 action，参数为固定 key-value，多余参数直接
`CLOUD_RELEASE_ARGS_INVALID` 失败关闭：

| action     | 必需参数                                                      |
| ---------- | ------------------------------------------------------------- |
| `status`   | 无（只读）                                                    |
| `prepare`  | `--candidate-sha` `--expected-current-sha` `--migration-head` |
| `finalize` | 以上三项 + `--release-token`                                  |
| `rollback` | 同 `finalize`                                                 |

`prepare` 成功后产出 release token，`finalize` 消费它。token 落在本地随机 `0700` 目录的
`release-token` 文件（33 字节，`0600`），运行结束后清理。**本轮实测该清理契约成立**：
20:59 创建的 token 目录在运行结束后已消失，未留残留。

## 4. 本轮合入的 PR

| PR                                                         | 合并（本地时间） | 规模        | 性质                         |
| ---------------------------------------------------------- | ---------------- | ----------- | ---------------------------- |
| [#156](https://github.com/manpengan/laundry-desk/pull/156) | 14:03            | +16404/-344 | ADR-37 + 发布/验收基线建立   |
| [#157](https://github.com/manpengan/laundry-desk/pull/157) | 16:31            | +743/-45    | 等待服务就绪、保留远端错误码 |
| [#158](https://github.com/manpengan/laundry-desk/pull/158) | 19:05            | +15/-1      | 真实失败定点修复 ①           |
| [#159](https://github.com/manpengan/laundry-desk/pull/159) | 19:49            | +8/-15      | 真实失败定点修复 ②           |
| [#160](https://github.com/manpengan/laundry-desk/pull/160) | 20:40            | +38/-7      | 真实失败定点修复 ③           |
| [#161](https://github.com/manpengan/laundry-desk/pull/161) | 22:21            | +3/-1       | 真实失败定点修复 ④           |

六个 PR 的 `workspace-check` 与 `real-postgres` required checks 均绿，合并后主线 CI 亦绿。

## 5. 五个真实失败与根因

①–④ 的失败点、诊断与修复口径引自对应 PR 正文；⑤ 来自 2026-08-10 深夜的人工诊断。
五次失败在管线中逐级加深，属收敛而非反复。前四个是环境事实且均已修复，第五个是尚未修复的
产品缺陷。

### ① staging 可写断言误报 symlink（#158）

- **失败**：对 `main=f1d7104` 的 `prepare` 返回 `CLOUD_RELEASE_STAGING_WRITABLE`，自动回滚为 stable。
- **根因**：Linux 上 symlink 权限位固定显示 `0777`，原 GNU `find` 表达式把 pnpm 的正常符号
  链接判为组/其他可写节点。远端最小复现证明旧表达式命中 symlink，限定普通文件和目录后零命中。
- **修复**：仅调整 staging 可写断言的 `find` 类型过滤，继续拒绝可写普通文件和目录，排除 symlink。
- **教训**：跨平台权限断言不能假设 symlink 的 mode 有意义。

### ② pnpm 生成的 0775 目录（#159）

- **失败**：排除 symlink 后 `prepare` **仍然**返回 `CLOUD_RELEASE_STAGING_WRITABLE`。
- **根因**：隔离重建同一 candidate 与同一构建环境后，首个真实节点为 `tools/migrate-v1/node_modules`，
  directory、mode `0775`、runtime ownership 切换后 owner `root:root`。pnpm 显式生成 `0775` 目录，
  而 `chown` 不移除 group 写位。
- **修复**：在 runtime ownership 切换后，对同一文件系统内的普通文件和目录移除 group/other 写位，
  再保留原「零可写节点」断言；不跟随 symlink。
- **教训**：`chown` 不等于 `chmod`；包管理器产出的目录权限必须显式归一，不能依赖 umask。

### ③ root-only dump 遇上 postgres 身份（#160）

- **失败**：`prepare` 推进到 shadow restore 阶段失败，稳定复现 Permission denied。
- **根因**：发布后的 dump 已收归 `root:root` `0600`，而 `pg_restore` 以 postgres 身份**按路径**打开。
- **修复**：改由 root shell 先打开严格绑定的私有 dump，再经 stdin 交给 postgres 身份的 `pg_restore`；
  保持 dump 的 `root:root` `0600`、摘要、shadow restore 与 catalog 断言不变，并增加回归锁定
  dump 不再作为 postgres 可见的路径参数。
- **新鲜证据（引自 PR）**：同一线上保留 dump restore 成功，`0045` ledger 保持，source/shadow
  catalog 661 项且摘要一致。
- **教训**：私有凭据/备份的「谁能打开」必须按**进程身份**推演，不能只看文件 mode。

### ④ 催取 fixture 回环判断（#161）

- **失败**：`finalize` 的远端 API acceptance 在 `reminder_history` fixture 失败，报
  `fixture connection is not loopback`。
- **根因**：真实 PostgreSQL 的 `inet_server_addr()::text` 返回带掩码的 `127.0.0.1/32`，
  与允许集合做字符串比较时判成非回环。同一连接只读诊断确认 URL host 确为 `127.0.0.1`。
- **修复**：改用 `host(inet_server_addr())`，允许集合仍严格限定 `127.0.0.1` 与 `::1`；
  补回归锁定不得退回带掩码文本比较。
- **教训**：PostgreSQL 的 `inet` 类型转文本自带掩码；网络身份断言应走 `host()`/`inet` 语义比较，
  不做裸字符串相等。

### ⑤ manual_list 在 confirm 重放路径上不幂等（未修复）

- **失败**：候选 `a832bbd` 的 `finalize` 返回 `CLOUD_RELEASE_REMOTE_API_EVIDENCE_FAILED`。
  绕开两层收敛后取得真实证据：15 条 journey **14 条 PASS**，仅 `reminder_history` FAIL，
  真实码为 `REMINDER_LIST_REPLAY_INVALID`（`machine-json` 把它归一成了 `ACCEPTANCE_FAILED`）。
- **失败断言**：`adr36-web-reminder-history.mjs` 的
  `requireThat(replayed.stable === verified.stable, "REMINDER_LIST_REPLAY_INVALID")`，
  其中 `stable = JSON.stringify(result)`，即整个响应信封。
- **根因判断**：`gatedReplayable` 的两次调用使用**同一个 `idempotencyKey` 与同一个
  `confirmRef`**，因此「重放逐字节相同」是幂等契约的正确预期，不是断言过严。而
  `apps/server/src/notification/handlers.ts` 的 `createHandler` 每次执行都
  `const batchId = randomUUID()` 并 `appendManualList` 写入新行。重放结果通过了全部结构
  校验、只有序列化不同，说明命令被**重新执行**而不是返回存储结果，即重放会产生重复批次。
  通用 PG 幂等 store 已接线（`createPgIdempotencyStore`），所以缺陷在 confirm 与幂等层的
  交互，不是未接线。
- **未确认项**：具体是哪些字段不同（`batch_id`/`filename` 全变，还是仅 `generated_at`）
  尚未逐字段取证；`notification_log` 已被 fixture cleanup 清空，无法回溯。修复前应先用
  一次带对比输出的运行确定字段差异。
- **不采取的做法**：放宽或删除该断言。这会把真实的数据完整性缺陷掩盖成绿灯。
- **教训**：命令级幂等必须覆盖 confirm/step-up 的二次提交路径，不能只覆盖直接提交路径；
  验收侧的「逐字节重放相同」是发现这类缺陷的有效探针，应保留。

## 6. 当前状态

全部为 2026-08-10 23:2x–23:30 的**直接实测**（本机 HTTPS 只读请求、pinned key-only SSH、本地 Git）：

| 项                          | 结果                                                    |
| --------------------------- | ------------------------------------------------------- |
| `/opt/laundry-desk` marker  | `a832bbdc5a0ced37be99a9057eab70edbbf5be01` —— 已切换    |
| 数据库迁移                  | 46 条，head `0046_print_job_request_idempotency.sql`    |
| transition `phase`          | `awaiting_external_verification`，`outcome=null`        |
| `write_gate_state`          | `released`（停写窗口已开合，终止会话 0）                |
| `compatibility_decision`    | `same_migration`；`old_code_compatible=true`            |
| 回滚树                      | `/opt/laundry-desk.rollback-ae9808c…-before-a832bbd…`   |
| 恢复点                      | `pre-a832bbd…dump`，含 sha256                           |
| `desk.manpengan.xyz/health` | `{"ok":true,"data":{"status":"ready"}}`                 |
| `desk.manpengan.xyz/` SPA   | `200`                                                   |
| `kb.manpengan.xyz/healthz`  | `200`                                                   |
| systemd                     | `laundry-desk`/`postgresql`/`caddy` 均 active，failed 0 |
| 公网 API acceptance         | 15 条 journey：14 PASS，`reminder_history` FAIL         |
| 工作树 / `main`             | clean；`main` = `origin/main`                           |

**这是一个受控的待验证态，不是半损状态**：新代码与新 schema 已在服务真实请求，回滚控制器、
回滚树与迁移前恢复点均在位，三站健康。缺的是把 transition 提交所需的外部验证证据。

## 7. 接手指引

阶段 1 的唯一阻塞项是 §5.5 的幂等缺陷。建议顺序：

1. 先跑 `--action status` 确认 transition 仍是 `awaiting_external_verification`、候选与
   token 未变；**不要**当成 `phase=stable` 重新开一轮 `prepare`。
2. 用一次带对比输出的运行确定 `verified.stable` 与 `replayed.stable` 的**逐字段差异**，
   补齐 §5.5 的未确认项。
3. 修 `notification.manual_list.create` 在 confirm 重放路径上的幂等性；补真实 PostgreSQL
   回归，锁定「同 key 同 confirmRef 重放返回存储结果且不新增批次」。
4. 走 PR、required CI 双绿、合入 `main`。
5. 用新 `main` SHA 重跑 `finalize`。若因候选 SHA 变化无法复用当前 transition，则先按控制器
   收束当前 transition，再从 `prepare` 重来。
6. 关闭阶段 1 时按运维手册另建发布**结果**记录，并在
   [ADR-36 Web 产品收口验收记录](../superpowers/specs/2026-08-09-adr36-web-product-convergence-acceptance.md)
   追加目标 SHA 证据。

纪律不变：只修本次真实失败的根因，不顺手加固，不放宽 marker、schema、health、清理或安全
断言，**尤其不得放宽 `REMINDER_LIST_REPLAY_INVALID` 断言**。

## 8. 本轮触达与未触达的管线阶段

已真实执行并通过：

- 候选门禁、staging 上传与权限归一、备份 dump、shadow restore、golden catalog 比对
- 迁移窗口：transition write-ahead、停写、`0045 → 0046`、恢复写入
- 代码切换与 marker 持久化、回滚树与恢复点建立
- 远端 API acceptance 的 14/15 条业务纵向

本轮**从未执行过**，首次执行仍可能暴露同类事实：

- 本地公网 Chromium `core_ui_subset` 只读子集（在 API 证据之后，未到达）
- transition 的最终提交与 `outcome` 落定

## 9. 已知遗留

- `/opt/laundry-desk.failed-1a588e791d269cc1153b243776b56f137b130b45`：Codex 上一轮
  （#160 合并点）失败留下的目录，尚未清理。清理前应确认它不被任何 rollback 控制器引用。
- 发布失败诊断需要绕开两层收敛才能取得逐 journey 证据：远端
  `hk-vps-release-remote-evidence.mjs` 在非 PASS 时直接 `fail("CLOUD_RELEASE_API_EVIDENCE_NOT_PASSED")`
  而不输出它已解析到的证据，本地侧再收敛为 `_FAILED`。本轮靠人工重跑底层 acceptance 才拿到
  `REMINDER_LIST_REPLAY_INVALID`。这是真实的可观测性缺口，建议后续让失败路径至少输出
  逐 journey 的 `journey/status/code`（不含秘密与 PII）。
