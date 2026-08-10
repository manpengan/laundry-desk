# hk-vps 阶段 1 发布尝试记录（2026-08-10）

- 环境：**开发测试** hk-vps，<https://desk.manpengan.xyz>
- 裁决：[ADR-37](../adr/2026-08-10-adr-37-cloud-web-primary-delivery.md) · [ADR-36](../adr/2026-08-09-adr-36-cloud-test-environment.md)
- 计划：[Cloud Web-first 1–4 交付计划](../superpowers/plans/2026-08-10-post-adr36-delivery-plan.md)
- 操作流程：[hk-vps 云测试环境运维手册](2026-08-09-hk-vps-cloud-test.md)

> **本文是尝试记录，不是发布证据。** 截至写作时阶段 1 **未关闭**：线上未切换到候选 SHA，
> 未产生通过的 API/UI 验收 run。发布结果证据必须按运维手册要求另行记录实际目标 SHA、
> required CI、transition 与最终状态。

## 1. 为什么单独记录

两阶段发布入口（`pnpm cloud:release:hk`）由 [#156](https://github.com/manpengan/laundry-desk/pull/156)
建立后，本日首次对真实 hk-vps 执行。首次执行连续暴露四个只有真连主机才会出现的环境事实，
每个都以定点修复收敛。这些根因不体现在任何单个 PR 的 diff 里，散落在六个 PR 正文中，
因此单独归档，供下次重试和后续阶段复用。

## 2. 基线与目标

| 项                  | 值                                    |
| ------------------- | ------------------------------------- |
| 本轮起始 `main`     | `6609c5e`（08-10 05:22）              |
| 本轮结束 `main`     | `9cc31c4`（08-10 22:21）              |
| 首个部署候选 SHA    | `f1d7104`（#157 合并点）              |
| 线上 release marker | `ae9808c` —— 见 §6，本文未经 SSH 复核 |
| 线上 migration head | `0045` —— 同上                        |
| 目标 migration head | `0046`                                |

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

## 5. 四个真实失败与根因

以下失败点、诊断与修复口径均引自对应 PR 正文，即执行者的第一手远端观察。四次失败在管线中
逐级加深，属收敛而非反复。

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

## 6. 当前状态

本节区分**直接复核**与**引用**两类证据。

直接复核（2026-08-10 22:37，本机 HTTPS 只读请求 + 本地 Git）：

| 项                          | 结果                                    |
| --------------------------- | --------------------------------------- |
| `desk.manpengan.xyz/health` | `{"ok":true,"data":{"status":"ready"}}` |
| `desk.manpengan.xyz/` SPA   | `200`                                   |
| `kb.manpengan.xyz/healthz`  | `200`                                   |
| 工作树                      | clean                                   |
| `main` 与 `origin/main`     | 同为 `9cc31c4`，0 ahead / 0 behind      |
| 全部 `codex/*` 分支         | 逐个 `merge-base` 验证，均已含入 `main` |
| 本地 release token 目录     | 已清理，无残留                          |

引用而**未**在本文复核（需 SSH 只读读取 `/opt/laundry-desk/.laundry-release.json`）：

- 线上 release marker 仍为 `ae9808c`、migration head 仍为 `0045`。依据是 #158 正文的
  明确记录，加上后续每轮失败均自动回滚为 stable、三站健康未变。**下次重试前必须实测确认。**

## 7. 下次重试前的检查清单

1. 先跑 `--action status`，确认 `phase=stable`、无 stale release lock、无未完成 transition。
2. 只读解析 `/opt/laundry-desk/.laundry-release.json`，实测当前 marker 与 migration head，
   用实测值填 `--expected-current-sha`，不沿用本文引用值。
3. 候选 SHA 用 `9cc31c4`（含四个修复），不是 `f1d7104`；确认其 required CI 双绿。
4. `prepare` → 检查 token 产出与 shadow restore/catalog 断言 → `finalize`。
5. 失败时保持定点修复口径：只修本次真实失败的根因，不顺手加固，不放宽 marker、schema、
   health、清理或安全断言。
6. 关闭阶段 1 时，按运维手册另建发布结果记录，并在
   [ADR-36 Web 产品收口验收记录](../superpowers/specs/2026-08-09-adr36-web-product-convergence-acceptance.md)
   追加目标 SHA 证据。

## 8. 尚未触达的管线阶段

`finalize` 在 ④ 处中断，以下阶段本轮**从未执行过**，首次执行仍可能暴露同类环境事实：

- 远端 API acceptance 在 `reminder_history` 之后的其余纵向
- 本地公网 Chromium `core_ui_subset` 只读子集
- 迁移窗口（transition write-ahead、`laundry_app NOLOGIN` 停写、恢复 LOGIN）
- marker 持久化与最终提交发布
