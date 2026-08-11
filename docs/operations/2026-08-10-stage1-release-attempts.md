# hk-vps 阶段 1 发布尝试记录（2026-08-10）

- 环境：**开发测试** hk-vps，<https://desk.manpengan.xyz>
- 裁决：[ADR-37](../adr/2026-08-10-adr-37-cloud-web-primary-delivery.md) · [ADR-36](../adr/2026-08-09-adr-36-cloud-test-environment.md)
- 计划：[Cloud Web-first 1–4 交付计划](../superpowers/plans/2026-08-10-post-adr36-delivery-plan.md)
- 操作流程：[hk-vps 云测试环境运维手册](2026-08-09-hk-vps-cloud-test.md)

> **本文是 2026-08-10 的历史尝试记录，不是当前发布证据。** 阶段 1 已于 2026-08-11
> 以 `7989206b3e9748b2a607687466ef2e0775ad528e` 完成 `prepare → finalize` 并关闭；权威结果见
> [阶段 1 发布结果](2026-08-11-stage1-release-result.md)。下文的部署值、transition 与接手步骤
> 均描述当时快照，不得当作当前线上状态或操作指引。

## 1. 为什么单独记录

两阶段发布入口（`pnpm cloud:release:hk`）由 [#156](https://github.com/manpengan/laundry-desk/pull/156)
建立后，本日首次对真实 hk-vps 执行。首次发布连续暴露五个此前未覆盖的事实：
前四个是环境事实，均以定点修复收敛；第五个后来确认是验收比较的 JSONB 键序误判，见 §5.5。
这些根因不体现在任何单个 PR 的 diff 里，散落在多个 PR 正文与人工诊断中，因此单独归档。

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

①–④ 的失败点、诊断与修复口径引自对应 PR 正文；⑤ 的初始现象来自 2026-08-10 深夜的
人工诊断，最终根因由 2026-08-11 的真实 PostgreSQL 回归确认。五次失败在管线中逐级加深，
属收敛而非反复；前四个环境事实与第五个验收误判均已完成本地修复。

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

### ⑤ manual_list 重放被 JSONB 键序误判（已修复并发布复验）

- **失败**：候选 `a832bbd` 的 `finalize` 返回 `CLOUD_RELEASE_REMOTE_API_EVIDENCE_FAILED`。
  绕开两层收敛后取得真实证据：15 条 journey **14 条 PASS**，仅 `reminder_history` FAIL，
  真实码为 `REMINDER_LIST_REPLAY_INVALID`（`machine-json` 把它归一成了 `ACCEPTANCE_FAILED`）。
- **失败断言**：`adr36-web-reminder-history.mjs` 的
  `requireThat(replayed.stable === verified.stable, "REMINDER_LIST_REPLAY_INVALID")`，
  其中 `stable = JSON.stringify(result)`。
- **补充取证（2026-08-11）**：按生产接线使用同一个 PG pending store、PG idempotency store、
  `idempotencyKey`、版本和 `confirmRef` 重放后，首次结果与重放结果深比较完全一致；
  `batch_id`、`filename`、`generated_at`、CSV、行内容及数组顺序均未变化，数据库也只有一个
  `notification_log` 批次。唯一差异是首次内存对象与从 `command_idempotency.result_json`
  (`jsonb`) 读回对象的**键顺序**不同。
- **根因**：JSON 对象键本来无顺序语义，PostgreSQL `jsonb` 也不保留输入键顺序；裸
  `JSON.stringify` 却把枚举顺序编码进字符串，因此把正确的持久化重放误判为重新执行。
- **修复**：复用验收已有的 `stableJson`，递归排序对象键后比较；数组顺序、字段值、CSV 原文
  和完整结果结构仍逐项受约束。真实 PostgreSQL 回归同时锁定同 key、同 confirmRef 的结果
  深相等且只写一个批次。
- **不采取的做法**：不删除重放断言，也不改成只比 `batch_id` 等字段子集；这些做法会掩盖
  真实结果或数组漂移。
- **教训**：幂等探针应比较 JSON 语义，而不是依赖对象键的序列化顺序；数据库副作用仍需用
  独立行数与批次断言证明。

修复由 [#164](https://github.com/manpengan/laundry-desk/pull/164) 合入；最终候选的 API
acceptance 已以同一 release identity 取得 15/15 PASS，见发布结果记录。

## 6. 当时状态（历史快照）

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

## 7. 后续闭环轨迹

2026-08-11 已按失败关闭纪律完成以下顺序；本节不再是待执行指引：

1. 使用原 transition 的完整 identity 受控 rollback，回到 `phase=stable` 与 live marker
   `ae9808ce1f3dc61535dbcc1cb89e618f0350ecf6`。
2. [#164](https://github.com/manpengan/laundry-desk/pull/164) 合入 JSONB 键序误判修复；
   [#165](https://github.com/manpengan/laundry-desk/pull/165) 修正空价目与当前 `orders → 欠款`
   路由的 Cloud Chromium 读面断言。
3. 两个 PR 及最终 merge SHA 的 required CI 依次通过；最终候选为
   `7989206b3e9748b2a607687466ef2e0775ad528e`。
4. 以旧 marker 作为 `expected-current-sha` 重新执行 `prepare → finalize`，取得 committed、
   authoritative 的 API/Browser evidence，并将 transition 归档回 stable。
5. 最终身份、run-id、服务/schema/公网审计见
   [阶段 1 发布结果](2026-08-11-stage1-release-result.md)。

纪律不变：只修本次真实失败的根因，不顺手加固，不放宽 marker、schema、health、清理或安全
断言，**尤其不得放宽 `REMINDER_LIST_REPLAY_INVALID` 断言**。

## 8. 本轮触达与未触达的管线阶段

已真实执行并通过：

- 候选门禁、staging 上传与权限归一、备份 dump、shadow restore、golden catalog 比对
- 迁移窗口：transition write-ahead、停写、`0045 → 0046`、恢复写入
- 代码切换与 marker 持久化、回滚树与恢复点建立
- 远端 API acceptance 的 14/15 条业务纵向

截至本次 2026-08-10 快照**尚未执行过**：

- 本地公网 Chromium `core_ui_subset` 只读子集（在 API 证据之后，未到达）
- transition 的最终提交与 `outcome` 落定

两项均已在 2026-08-11 的最终候选上执行并通过；当前证据见发布结果记录。

## 9. 当时已知遗留

- `/opt/laundry-desk.failed-1a588e791d269cc1153b243776b56f137b130b45`：Codex 上一轮
  （#160 合并点）失败留下的目录，尚未清理。清理前应确认它不被任何 rollback 控制器引用。
- 发布失败诊断需要绕开两层收敛才能取得逐 journey 证据：远端
  `hk-vps-release-remote-evidence.mjs` 在非 PASS 时直接 `fail("CLOUD_RELEASE_API_EVIDENCE_NOT_PASSED")`
  而不输出它已解析到的证据，本地侧再收敛为 `_FAILED`。本轮靠人工重跑底层 acceptance 才拿到
  `REMINDER_LIST_REPLAY_INVALID`。这是真实的可观测性缺口，建议后续让失败路径至少输出
  逐 journey 的 `journey/status/code`（不含秘密与 PII）。
