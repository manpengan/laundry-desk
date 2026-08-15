# hk-vps 云测试环境运维手册（ADR-36/37）

- 环境：**开发测试**，允许随时丢弃，不承载真实顾客 PII
- 地址：<https://desk.manpengan.xyz>
- 主机：SSH alias `hk-vps`（实际地址和密钥由操作者的 SSH 配置管理）
- 裁决：[ADR-36](../adr/2026-08-09-adr-36-cloud-test-environment.md) · [ADR-37](../adr/2026-08-10-adr-37-cloud-web-primary-delivery.md)

本文件是操作流程，不是部署结果。命令输出格式和判据不能作为「已经发布」的证据；每次发布
必须另行记录实际目标 SHA、required CI、transition、API/UI run-id 与最终状态。

## 固定拓扑与安全边界

```text
browser → Caddy :443 → 127.0.0.1:8787 Fastify
                              ↓
                     PostgreSQL 16 localhost:5432
```

| 项              | 固定位置/身份                                                          |
| --------------- | ---------------------------------------------------------------------- |
| 应用树          | `/opt/laundry-desk`，`root:root`，服务只读                             |
| Node            | `/opt/nodejs/bin/node`（Node 22）                                      |
| systemd         | `/etc/systemd/system/laundry-desk.service`，以 `laundry:laundry` 运行  |
| 服务环境与密钥  | `/etc/laundry-desk/server.env`，`root:root`、`0600`                    |
| PostgreSQL      | 裸机 PostgreSQL 16，只监听 `127.0.0.1`/`::1`                           |
| 运行数据        | `/var/lib/laundry-desk`、`/var/lib/laundry`                            |
| Caddy           | `/etc/caddy/Caddyfile` 中 `desk.manpengan.xyz` 站点                    |
| 版本标识        | `/opt/laundry-desk/.laundry-release.json`                              |
| 发布 transition | `/var/lib/laundry-desk-release/transition.json`                        |
| 发布回滚控制器  | `/var/lib/laundry-desk-release-controllers/`                           |
| 迁移恢复点      | `/var/lib/laundry-desk-release-backups`                                |
| 发布验收配置    | `/etc/laundry-desk/adr36-acceptance.env` 与 `acceptance-secrets/`      |
| 发布验收证据    | `/var/lib/laundry-desk-release/verification-<sha>-<token-sha256>.json` |

`desk.manpengan.xyz` 在 `:443` 的唯一实际 handler 必须只把 `/health`、`/api/*`、`/v1/*` 送入以下
Desk upstream/header contract；`header_up` 是覆盖而非追加，故浏览器同名伪造值不能穿透。release preflight
用唯一权威 parser 读取 `caddy adapt` JSON；缺 Host/source 覆盖、任一 forwarding 删除、唯一 upstream，或
仅有安全 decoy 而真实 route 不安全时都拒绝候选：

```caddyfile
reverse_proxy 127.0.0.1:8787 {
	header_up Host 127.0.0.1:8787
	header_up -Forwarded
	header_up -X-Forwarded-*
	header_up -X-Real-IP
	header_up X-Laundry-Proxy-Client-Ip {remote_host}
}
```

禁止在命令、终端输出、Git、工件或支持包中复制 `server.env`、验收凭据或数据库 URL 的值。
发布只上传目标 Git commit 的 `git archive`；不得把服务器密钥拉回本地，也不得继续使用旧的
手工 rsync/rename 流程。

## 两阶段发布总览

发布入口固定为：

```bash
pnpm cloud:release:hk -- --action status
pnpm cloud:release:hk -- --action prepare  --candidate-sha <sha> --expected-current-sha <sha> --migration-head <file>
pnpm cloud:release:hk -- --action finalize --candidate-sha <sha> --expected-current-sha <sha> --migration-head <file> --release-token <token>
pnpm cloud:release:hk -- --action rollback --candidate-sha <sha> --expected-current-sha <sha> --migration-head <file> --release-token <token>
```

`prepare` 与 `finalize` 是发布的两个阶段；`status` 只读检查 transition 且不输出 release
correlation nonce，`rollback` 只在候选
验收失败且仓库兼容策略允许时回退代码。不得跳过 `prepare` 直接 `finalize`，也不得在
`prepare` 后只看 `/health` 就提交发布。

## 1. 发布候选与前置门禁

发布必须从仓库根目录、已更新的本地 `main` 执行。`prepare` 会自行失败关闭以下条件：

- 工作树（含 untracked）精确干净；当前分支是 `main`；
- `HEAD`、`origin/main` 与 `--candidate-sha` 是同一个完整 40 位 SHA；
- GitHub 上该 SHA 最新的 `workspace-check` 与 `real-postgres` 都是 completed/success；
- `ssh -G hk-vps` 固定到获授权的 root、主机、22 端口、专用 identity，禁用密码与交互认证；
- 现场 `ssh-keyscan` 得到唯一的固定 Ed25519 fingerprint；不匹配时在上传前失败；
- 当前 release marker 精确等于 `--expected-current-sha`，迁移账本是候选迁移清单的严格前缀；
- 没有另一个活动 transition，systemd/Caddy/目录权限和同机共享服务契约均未漂移；
- `/opt` 与 PostgreSQL 所在文件系统分别至少有 8 GiB 可用空间，精确识别的候选归档、发布
  history、rollback tree、root 私有回滚控制器与 backup set 都没有达到保守留存上限 8 组；
  每份历史中的恢复点必须与目录内唯一 dump/manifest 成对对应并重新通过摘要与 manifest 验证，
  缺失、复用、篡改或合法命名的 orphan 也会拒绝下一次发布；
- KB 的 `127.0.0.1:8700/healthz` 与公网 `/healthz` 同时通过，PostgreSQL 5432、KB 8700 和
  Desk 8787 均保持 loopback 绑定，相关 systemd unit 无 failed 状态。

### 1.1 退役产物的可恢复归档

保留上限是 `MAX_RETAINED_RELEASES = 8`，预检峰值为当前 `/opt/laundry-desk.*` 计数再加
incoming 与 next 两项。计数到 6 时下一次 `prepare` 必然以
`CLOUD_RELEASE_ARTIFACT_RETENTION_LIMIT` 失败关闭。发布链**从不自动删除**任何产物，
腾出槽位是一次单独授权的动作。

> **不要只按 `assertRoomForRelease` 的字面阈值推断。** 该函数写的是 `count >= 8`，只读代码
> 会得出「常驻 6 也能过」的错误结论；但 `ARTIFACT_PATTERNS` 里确实存在
> `laundry-desk.incoming-<sha>-<token>.tar` 与 `laundry-desk.next-<sha>`，发布过程中 `/opt`
> 会临时多出这两项，`6 + 2 = 8` 正好触顶。**`/opt` 的有效上限是常驻 ≤ 5。**
> 2026-08-15 曾因此浪费一次尝试（前一次失败留下的 `laundry-desk.failed-<sha>` 把常驻从 5
> 推到 6，下一次 `prepare` 在预检即失败）。
>
> 同理，一次**进入停写窗口**的失败会同时消耗四个集合各一格：history +1、backup +1 对、
> `/opt` +1 树、controller +1。规划发布前应逐个集合核对余量，而不是只看 `/opt`。

归档只做同文件系统原子 rename，不删除任何东西，反向 rename 即可完整还原。工具会拒绝
任何没有被 history 证明为 `rolled_back` 且 `verification_evidence_authoritative=false` 的
产物 —— 活动版本的 rollback tree 绑定的是 `committed` 记录，因此永远不会被移动；没有任何
history 绑定的产物同样一律拒绝。

入口随 `tools/cloud/` 一起进入发布产物，因此**只有部署树包含该文件的版本上线之后**这两条
命令才可用；在此之前 `/opt/laundry-desk/tools/cloud/` 里没有它，会直接 `MODULE_NOT_FOUND`。
同理，工具自身的修复也要先发布才能生效：2026-08-15 之前部署树里的版本因 `measureTree` 拒绝
符号链接而**无法归档任何真实产物**（真实部署树都是 pnpm workspace），修复本身又要靠一次发布
才能上线，构成鸡生蛋。遇到这种情况时，腾槽位只能按当轮授权手工守卫式搬迁：先做身份证明
（`outcome`、`verification_evidence_authoritative`、controller/backup 绑定唯一性、live marker
不同），再同文件系统原子 rename，最后逐项核对 inode 与剩余集合的 1:1 关系。
注意 history 记录里表示状态的字段是 `outcome` 而不是 `state`。

先只读列出可归档项，再对精确名字执行：

```bash
ssh hk-vps /opt/nodejs/bin/node \
  /opt/laundry-desk/tools/cloud/hk-vps-release-artifact-archive-run.mjs --list
```

```bash
ssh hk-vps /opt/nodejs/bin/node \
  /opt/laundry-desk/tools/cloud/hk-vps-release-artifact-archive-run.mjs \
  --archive laundry-desk.failed-<40 位 SHA>
```

### 无主产物

`--list` 只列出 history 证明为 `rolled_back` 的产物。早于 transition 账本的安全点（例如
`laundry-desk.rollback-pre-<短 SHA>-<时间戳>`）不会被任何记录引用，因此永远不在该列表里，
但同样占用保留槽位。

这类产物走独立子命令，不是 `--archive` 的开关 —— 退役账本从未认领的树是一个单独授权的决定，
在 shell 历史里也应当读起来就是如此：

```bash
ssh hk-vps /opt/nodejs/bin/node \
  /opt/laundry-desk/tools/cloud/hk-vps-release-artifact-archive-run.mjs \
  --archive-orphan laundry-desk.rollback-pre-<短 SHA>-<时间戳>
```

该路径比 `--archive` **更严**：任何一条 history 记录只要引用了该路径（无论 `rollback_path`
还是 `failed_path`）即拒绝，因此活动或历史回滚目标都不可能走到这里；此外还要求该产物自身的
release marker 与 live marker 不同，作为「它不是当前部署」的第二重独立证明。成功输出带
`orphan_marker=<该树的 git_sha>` 而非 `candidates=`。

成功输出 `CLOUD_RELEASE_ARTIFACT_ARCHIVE_OK entries=… bytes=… ino=… target=…`；`ino` 与
移动前一致即证明是同一对象而非复制。归档根为 `/var/lib/laundry-desk-release-archive`
（root:root `0700`）。history、controller、backup 与 verification evidence 都不在 `/opt`，
归档不会触及它们。本地回归为
`pnpm cloud:release:hk:artifact-archive:test`。

先更新并核对候选：

```bash
git fetch origin main
git switch main
git pull --ff-only origin main
test -z "$(git status --porcelain=v1 --untracked-files=all)"

CANDIDATE_SHA="$(git rev-parse HEAD)"
test "${CANDIDATE_SHA}" = "$(git rev-parse origin/main)"

MIGRATION_HEAD="$(
  git ls-tree -r --name-only "${CANDIDATE_SHA}" packages/db/src/migrations |
    sed -n 's#^packages/db/src/migrations/\([0-9][0-9][0-9][0-9]_[a-z0-9_]*\.sql\)$#\1#p' |
    LC_ALL=C sort |
    tail -n 1
)"
test -n "${MIGRATION_HEAD}"
```

`--expected-current-sha` 不是候选 SHA，也不能凭记忆填写。先运行只读状态检查；它也会验证
SSH 配置与固定 fingerprint：

```bash
pnpm cloud:release:hk -- --action status
```

若输出 `phase=stable`，再以严格 key-only SSH 只读解析当前 marker，并把唯一的 40 位输出
记录为 `EXPECTED_CURRENT_SHA`。以下命令不读取任何 env 或秘密：

```bash
EXPECTED_CURRENT_SHA="$(
/usr/bin/ssh \
  -o BatchMode=yes \
  -o PasswordAuthentication=no \
  -o KbdInteractiveAuthentication=no \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  hk-vps /opt/nodejs/bin/node --input-type=module - <<'NODE'
import { readFile } from "node:fs/promises";
const marker = JSON.parse(await readFile("/opt/laundry-desk/.laundry-release.json", "utf8"));
if (
  marker.environment !== "hk-vps-cloud-test" ||
  typeof marker.git_sha !== "string" ||
  !/^[0-9a-f]{40}$/u.test(marker.git_sha)
) process.exit(2);
process.stdout.write(marker.git_sha + "\n");
NODE
)"
case "${EXPECTED_CURRENT_SHA}" in
  (*[!0-9a-f]*|'') exit 2 ;;
esac
test "${#EXPECTED_CURRENT_SHA}" -eq 40
```

若 `status` 不是 `stable`，不要创建第二个候选；先按「中断与恢复」处理现有 transition。

## 2. Prepare：停在外部验收窗口

用刚才记录的三个精确值执行：

```bash
pnpm cloud:release:hk -- \
  --action prepare \
  --candidate-sha "${CANDIDATE_SHA}" \
  --expected-current-sha "${EXPECTED_CURRENT_SHA}" \
  --migration-head "${MIGRATION_HEAD}"
```

工具生成一次性 32 位 release correlation nonce。它用于把后续动作关联到同一个 transition，
真正的操作权威仍是固定指纹的 root SSH、root-only 状态文件和 exact identity。成功输出格式如下
（占位符不是实际证据）：

```text
CLOUD_RELEASE_AWAITING_EXTERNAL_VERIFICATION candidate_sha=<sha> expected_sha=<sha> token=<token> migration_head=<file>
```

立即把这一行的四个字段记录到本次发布记录；后续 `finalize`/`rollback` 必须精确复述，不能
只凭 candidate SHA 猜测 transition。

### Prepare 的受控顺序

`prepare` 自动完成以下步骤，任何一步不满足都失败关闭：

1. 从 exact clean `origin/main` 创建临时 `git archive`，校验 SHA-256 后上传；工作区文件、
   untracked、`.git` 与本地构建产物不进入候选。
2. 远端 root runner 持有独占 release lock，从已核对摘要的候选归档把版本化回滚控制器原子发布
   到 root 私有目录；控制器的完整文件清单、逐文件 SHA-256、候选/旧 SHA、迁移头、归档摘要和
   correlation nonce 摘要均绑定进 transition。若在控制器发布后、transition 写入前中断，下一次
   `prepare` 只会在同一锁下验证并清理由该流程留下的未绑定控制器。
3. 停止 `laundry-desk.service`，核对专用 `laundry_app` 角色是 LOGIN、NOSUPERUSER、
   NOBYPASSRLS；先把 `write_gate_state=intent` 与原状态写入 transition，再将该角色改为 NOLOGIN，
   终止并复核它在 `laundry_v2` 中的全部现存会话。随后读取最终迁移账本，并按 PostgreSQL 16、
   当前 migration head 绑定的 golden policy 核对 owner、ACL、policy、RLS/FORCE RLS、function
   与 cluster/bootstrap catalog；只有 NOLOGIN、零应用会话和 catalog 证据完整时才持久化
   `write_gate_state=active` 与 `write_frozen`。受信的 root/postgres 发布连接仍用于备份和迁移，
   但业务账号在整个窗口无法重新连接。
4. 只有服务已停且写门闩已激活，才把 root-owned staging 临时交给 `laundry` 用户执行 frozen
   install 和 Server/Web build；随后恢复 root-owned、不可组/其他用户写的运行树。迁移 runner
   与全部 migration 在交出 staging 前生成摘要权威，构建后必须逐项复核；root 不执行 staging
   中的迁移脚本。
5. 在停写窗口内对 `laundry_v2` 执行 custom-format **database-only、same-cluster** `pg_dump`
   并计算 SHA-256；随后在同一 PostgreSQL 集群创建临时 shadow database，完整
   `pg_restore --single-transaction`，比较源库/影子库的完整迁移账本摘要及规范化 relation、
   function、owner、ACL、policy、RLS/FORCE RLS catalog 摘要。shadow 删除成功后才把严格
   manifest 标为 verified；若删除失败则保留可定位恢复证据并进入 `recovery_required`。
6. 只有恢复点和影子恢复都通过，才由摘要绑定的 root 私有控制器从原始候选归档提取并复核
   迁移 runner 与全部 migration，再从该 root 私有副本应用迁移；要求迁移账本与候选清单精确
   一致，并再次按候选 migration head 的 golden policy 核对停写态 catalog。随后原子切换代码树，幂等恢复
   `laundry_app LOGIN`、持久化 `write_gate_state=released` 后才启动服务，再核对
   loopback/public health、SPA、marker、rollback tree、恢复点、稳定态 catalog、PostgreSQL
   loopback 和 `https://kb.manpengan.xyz/healthz`。
7. transition 停在 `awaiting_external_verification`，等待下一节由 `finalize` 亲自启动的公网
   业务与 UI 验收；工具不会因健康检查通过而自动提交。

这里的恢复点只包含数据库，且只在同一 PostgreSQL 集群做过影子恢复；它不包含私有照片，
不等于 ADR-33 完整数据保护、离机备份、生产灾备或 SLA 证据。

### ADR-43 周期数据保护（软件候选，尚未安装）

[ADR-43](../adr/2026-08-12-adr-43-cloud-data-protection-and-joint-recovery.md) 新增的 root-only
runner 会把 PostgreSQL、迁移/catalog 权威和 `/var/lib/laundry/photos` 组成同一恢复集，并与
发布控制器共用 `/run/lock/laundry-desk-cloud-release.lock`。本节记录安装后的标准入口，**不表示
这些 unit、离机挂载或告警接收端已在 hk-vps 安装或验收**：

```bash
sudo /opt/nodejs/bin/node /opt/laundry-desk/tools/cloud/hk-vps-data-protection.mjs status
sudo /opt/nodejs/bin/node /opt/laundry-desk/tools/cloud/hk-vps-data-protection.mjs backup
sudo /opt/nodejs/bin/node /opt/laundry-desk/tools/cloud/hk-vps-data-protection.mjs drill
sudo /opt/nodejs/bin/node /opt/laundry-desk/tools/cloud/hk-vps-data-protection.mjs offsite
```

`status` 每次重新验证恢复集、离机副本、最近演练、服务、marker、迁移和 write gate；在没有
26 小时内本机备份/离机副本或 8 天内演练时按设计返回非零。`offsite` 只接受精确挂载在
`/mnt/laundry-desk-offsite` 的 `nfs4`、`cifs` 或 `fuse.sshfs`，并要求
`rw,nodev,nosuid,noexec,nosymfollow`、独立设备和独立 marker。普通本地目录或同盘 bind mount
不能冒充离机完成。

真实离机状态还依赖固定的
`/etc/laundry-desk/data-protection-offsite-authority.json`。该文件必须是 root-owned、0600、单链接
普通文件，采用严格 canonical JSON，精确包含 `schema`、`version`、`target_id`、`mount_source`、
`mount_fstype`、`failure_domain`、`remote_identity`、`attested_at` 与 `expires_at`。其中 source/fstype
必须与 `findmnt` 一致，failure domain 不能是 hk-vps/local，remote identity 必须来自已核验的远端
存储身份，过期时间最长一年。凭据、私钥和口令不得放进这个文件。没有这份部署证明，或证明与
挂载不一致/已过期时，`status` 必须保持 `delivery_state=software_only`、
`blocked_external_offsite` 且非健康；不要为了让指标变绿而手工伪造证明。

安装候选 unit 前，先核对目标 checkout 的精确 SHA、以 `systemd-analyze verify` 验证
`tools/cloud/systemd/laundry-desk-data-*`，再由单独获权的主机变更把 root-owned `0644` unit
安装到 `/etc/systemd/system` 并启用 timer。候选 oneshot unit 使用 `ProtectSystem=strict`、精确
`ReadWritePaths`、受限 proc/device/kernel 面，并为 status 设置 10 分钟、其余维护动作设置 30 分钟
超时。真实关闭条件还包括至少一次本机恢复集、离机复制、独立演练、阈值失败和告警送达；只有
unit 文件或 journal 输出不算完成。

联合恢复是独立破坏性操作，不由 timer 触发。它只接受 runner 列出的 set id，并从 stdin 读取
`RECOVER-<manifest SHA-256 前12位>`；执行前还会创建 `pre_recovery` 集并验证目标代码树。必须在
明确的数据损失窗口与恢复授权下另行执行：

```bash
printf '%s\n' 'RECOVER-<12-hex>' | \
  sudo /opt/nodejs/bin/node /opt/laundry-desk/tools/cloud/hk-vps-data-protection.mjs \
    recover --set-id '<verified-set-id>'
```

恢复开始改写后的任一失败会保持 Desk 停止、`laundry_app NOLOGIN` 和 `recovery_required`；不要
手工恢复 LOGIN、只切代码或只换照片。先保留 operation/state、目标 set 和 pre-recovery 证据，
再制定显式恢复或回退动作。

### Transition 与恢复点权限

- `/var/lib/laundry-desk-release` 及 history 必须是 `root:root`、`0700`；活动
  `transition.json` 必须是 root-owned 普通文件、`0600`，且以原子 rename + fsync 更新。
- `/var/lib/laundry-desk-release-controllers` 必须是 `root:root`、`0700`。每个控制器目录是
  `root:root 0700`，文件是单链接普通文件、`0600`；launcher 与 rollback entry 都属于逐文件
  摘要覆盖的版本化 controller，不使用可交换的 live 目录或全局首版 launcher。不要手工复制、
  修改或删除 controller。
- 远端 release runner 必须以 uid 0 执行；普通用户不能 finalize、rollback 或改写 transition。
- transition 的 `app_role_original_can_login` 与 `write_gate_state` 是 crash recovery 的权威记录：
  `intent` 与 `active` 都要求回滚在启动旧代码前幂等恢复 LOGIN；`released` 才允许启动业务服务。
  不兼容迁移进入 `recovery_required` 时保持 NOLOGIN 与停服，不能手工绕开写门闩。
- `/var/lib/laundry-desk-release-backups` 必须是 `root:postgres`、`0710`：PostgreSQL 只能按
  root 创建的随机路径写临时 dump，不能列目录、创建、删除或替换目录项。dump 完成后立即收回为
  `root:root` 普通文件、`0600`；manifest 从创建起就是 `root:root`、`0600`，并绑定候选/旧
  SHA、迁移头、完整账本与 catalog 摘要、字节数和 `shadow_restore=verified`。
- 不手工编辑 transition、manifest 或 compatibility policy；身份或阶段不匹配时重新 `status`
  并停下来诊断。

## 3. Prepare 后的强制公网验收

只有 `status` 返回 `phase=awaiting_external_verification` 才可执行 `finalize`：

```bash
pnpm cloud:release:hk -- --action status
```

`finalize` 不接受操作者提供的 `PASS` 文本或既有证据文件，而会在本次调用中亲自启动两套全新
子进程：

1. VPS live root 内的 ADR-36 API acceptance，含受控历史催取 fixture；
2. 发布机上的真实 Chromium `core_ui_subset`，只读访问公网产品 UI。

两者都输出一行严格、版本化 JSON；本地 orchestrator 再生成唯一 `verification_id`，把 API/UI
run-id 与 candidate SHA、旧 SHA、迁移头、correlation nonce 摘要和创建时间组成 canonical
evidence，经 SSH stdin 交给远端。证据不得进入 argv，也不得包含密码、PIN、Cookie、token、
数据库 URL、请求体或顾客数据。远端在同一 release lock 下再次校验 transition、marker、health、
迁移账本与恢复点，以 `root:root 0600` 原子持久化证据并把 SHA-256 绑定进 transition；任一
子进程失败、skip、retry、输出多余文本、证据超过 30 分钟或 identity 漂移都会失败关闭。

### 3.1 VPS 私有 API acceptance 与历史催取 fixture

fixture 只能在 `/opt/laundry-desk` 的 `hk-vps-cloud-test` release marker 下运行，只接受
loopback `postgres` 管理连接到 `laundry_v2`。它为当前 run 建立 31/91/181 天、分别覆盖
30/90/180 天门槛的合成订单，验证候选/名单/CSV 与审计后事务清理；不能指向生产、远端
数据库或其他工作目录。

`prepare` 会从既有 root-only `server.env` 读取当前管理员、复核人和 admin database URL，
不通过 shell 展开、不输出值，并建立发布专用配置：

- `/etc/laundry-desk/acceptance-secrets`：`root:root`、`0700`；
- 8 个管理员/复核人字段文件和一个 admin database URL 文件：普通文件、`root:root`、
  精确 `0600`、单行且无 CR/LF、不得是符号链接；
- `/etc/laundry-desk/adr36-acceptance.env`：`root:root`、`0600`，只保存下列文件路径与精确
  opt-in，不保存到 Git，也不在命令行展开秘密。

私有 env 的字段名固定为：

```bash
LAUNDRY_BOOTSTRAP_ADMIN_USERNAME_FILE=/etc/laundry-desk/acceptance-secrets/admin-username
LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME_FILE=/etc/laundry-desk/acceptance-secrets/admin-display-name
LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD_FILE=/etc/laundry-desk/acceptance-secrets/admin-password
LAUNDRY_BOOTSTRAP_ADMIN_PIN_FILE=/etc/laundry-desk/acceptance-secrets/admin-pin
LAUNDRY_BOOTSTRAP_APPROVER_USERNAME_FILE=/etc/laundry-desk/acceptance-secrets/approver-username
LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME_FILE=/etc/laundry-desk/acceptance-secrets/approver-display-name
LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD_FILE=/etc/laundry-desk/acceptance-secrets/approver-password
LAUNDRY_BOOTSTRAP_APPROVER_PIN_FILE=/etc/laundry-desk/acceptance-secrets/approver-pin
LAUNDRY_ADR36_DATABASE_ADMIN_URL_FILE=/etc/laundry-desk/acceptance-secrets/database-admin-url
LAUNDRY_ADR36_REMINDER_FIXTURE=APPLY_SYNTHETIC_HISTORY_ON_HK_VPS
```

管理员连接文件必须是 loopback `laundry_v2` 的单行管理 URL；验收 env 只保存 `_FILE` 路径，
不保存直接秘密。若任一既有发布专用文件与当前 `server.env` 不一致，`prepare` 失败关闭，不覆盖
未知内容。API 子进程由绝对 Node 入口启动，环境白名单只含上述 9 个 `_FILE`、精确 fixture
opt-in、固定 locale/PATH，不继承完整 `server.env`。

退出码含义：

| 退出码 | 含义                                                                                  |
| -----: | ------------------------------------------------------------------------------------- |
|      0 | 全部 API 旅程、历史催取 proof/verify、safe cleanup 与 logout 通过                     |
|      1 | 配置、业务、fixture、验证或清理失败；不得 finalize                                    |
|      2 | 未提供 exact opt-in，安全子集可通过但 `reminder_history` 仍 blocked；不得视为验收成功 |

精确 opt-in 只有：

```text
LAUNDRY_ADR36_REMINDER_FIXTURE=APPLY_SYNTHETIC_HISTORY_ON_HK_VPS
```

未设置时必须保留退出码 2；设置为 `yes`、`1` 或其他近似值会失败关闭。fixture 已建立但
cleanup 失败时，overall 必须为失败；`finalize` 不会持久化通过证据，应按唯一 run-id 诊断并
受控清理。

### 3.2 公网浏览器 Cloud Web E2E

`cloud:web:e2e` 固定访问 `https://desk.manpengan.xyz`，不会启动本地服务，也拒绝任何数据库
环境变量和其他 origin。它被明确限定为 `core_ui_subset`：登录后只读取工作台、当前价目、
订单、生产、客户、催取和账目页面，运行时断言没有任何 `/v1/commands/*` 请求，最后注销会话。
它不创建或接管顾客、订单、会员、价目，不执行导出，也不做任何不可逆业务清理。

`finalize` 通过本轮临时、固定 fingerprint 的 `known_hosts`，把 VPS 上 8 个浏览器字段精确下载
到发布机随机 `0700` 目录，逐个要求当前用户 owner、普通文件、`0600`、单行、无符号链接；不会
下载 admin database URL 或 `server.env`。随后用当前 Node 直接执行仓库解析出的 Playwright
CLI，不经 shell/package-script 输出层；成功或失败都会删除临时凭据目录。

发布入口发现任何直接 `LAUNDRY_BOOTSTRAP_*` 字段都会在网络动作前拒绝；浏览器子进程使用
白名单环境，不继承 GitHub token、数据库变量、release identity 或其他服务秘密。截图、视频、
trace 与下载全部关闭。报告只能记录安全 run-id 与固定状态：`core_ui_subset`、
`session_logout`、`business_cleanup NOT_REQUIRED`、`standalone_completion NOT_AUTHORIZED`。

Browser subset **没有独立关闭权**。完整业务写入、双管理员/员工、收退款、会员生命周期、
交班、催取、CSV 与清理证据只由上一节退出码 0 的 ADR-36 API acceptance 提供；本节只证明
同一候选的公网真实浏览器读面可达。两者都通过，才满足阶段 1 的公网验收条件。

## 4. Finalize

使用 `prepare` 输出中保存的完整 transition identity 调用 `finalize`。该命令会执行上一节的
全新 API/Browser 验收；无需、也不能先把人工 `PASS` 或旧 evidence 路径传给它。`status` 只
显示非秘密身份字段，不会恢复或回显 correlation nonce：

```bash
pnpm cloud:release:hk -- \
  --action finalize \
  --candidate-sha "${CANDIDATE_SHA}" \
  --expected-current-sha "${EXPECTED_CURRENT_SHA}" \
  --migration-head "${MIGRATION_HEAD}" \
  --release-token "${RELEASE_TOKEN}"

pnpm cloud:release:hk -- --action status
```

`finalize` 会在写入证据前和原子归档 transition 前再次核对 desk public/loopback health、SPA、
marker、恢复点、rollback tree、完整迁移账本、稳定态 golden catalog、PostgreSQL loopback、KB loopback/public health 与
两份 machine evidence，然后把 root-only transition 原子移入 history。若归档已经提交但 SSH
响应丢失，使用同一完整 identity 重试；工具会从精确的 committed history、保留证据和当前系统
状态对账，不会再次提交发布。成功后的 `status` 应为 `phase=stable`。只有实际出现
`CLOUD_RELEASE_COMMITTED candidate_sha=<目标 SHA>` 且验收记录已落档，才能声明发布完成。

不要在 finalize 后立即手工删除 rollback tree、dump、manifest、history、verification
evidence 或 root 私有 controller；保留与清理由后续明确的 retention 策略处理，不能使用宽泛
glob 或未验证路径递归删除。每份 committed history 必须一对一绑定
`authoritative=true` 的 evidence 和摘要匹配的 controller；若验收后回滚，
同一 evidence 仍保留，但 rolled-back history 必须标记 `authoritative=false`。`recovery_required`
也保留已生成的 evidence 且视为非权威。下一次 `prepare` 会逐一核验 owner/mode、摘要、history
关联和无 orphan；恢复点还会按 history 逐份重算 dump SHA 并复核 verified manifest。任一精确
留存集合达到 8 组前都会失败关闭，不会自动删证据。

## 5. 验收失败、回滚与恢复

先读取活动 transition：

```bash
pnpm cloud:release:hk -- --action status
```

若候选 API/UI 验收失败，并且没有需要保留的现场调查，使用同一完整 identity 请求代码回滚：

```bash
pnpm cloud:release:hk -- \
  --action rollback \
  --candidate-sha "${CANDIDATE_SHA}" \
  --expected-current-sha "${EXPECTED_CURRENT_SHA}" \
  --migration-head "${MIGRATION_HEAD}" \
  --release-token "${RELEASE_TOKEN}"
```

回滚的严格边界：

- 只在 transition phase 与 identity 精确匹配时执行；
- `rollback` 的 identity 只经标准输入交给 candidate + correlation nonce 摘要派生的 root 私有
  controller；从 `staged` 到 `recovery_required` 的所有可回滚相位都执行该已验证 controller，
  即使 `/opt/laundry-desk` 正在 rename、暂时不存在或已经是候选版本也不依赖 live 内入口。
  回滚已经归档但 SSH 响应丢失时，以同一完整 identity 重试会从 rolled-back history 对账。
- `prepare` 内部若在迁移开始前失败，会自动撤销 staging 或恢复原服务；`prepare` 已成功返回
  后，只有候选仓库的 `hk-vps-release-compatibility.json` 以 ADR 记录当前迁移跨度对旧代码
  兼容时，显式 `rollback` 才切回旧代码；
- 未开始迁移或已声明兼容的回滚会先恢复旧代码，再幂等恢复 `laundry_app LOGIN`，确认
  `write_gate_state=released` 后才启动旧服务；即使进程在停服、NOLOGIN 或 transition 原子写之间
  中断，同一 root 私有 controller 也按磁盘状态重放这一顺序；
- 未声明兼容时工具转为 `recovery_required` 并失败关闭，可能保持 desk 停止；不得绕过 policy、
  手工 rename、手工恢复 LOGIN 或伪造完成 marker；
- **数据库恢复永不自动执行。** `rollback` 只回退代码，并让已迁移数据库继续保留；prepare
  产生的 dump 是人工恢复依据，不是自动 down migration；
- 人工数据库恢复会覆盖 prepare 后的写入，属于独立破坏性操作。必须先停止业务、核对
  transition/dump/manifest/SHA、明确数据损失范围并取得单独授权，再制定恢复与复验方案。

任何 `CLOUD_RELEASE_RECOVERY_REQUIRED`、transition 损坏、恢复点校验失败或服务未恢复，都要
保持现场、记录稳定错误码并停止继续发布；不要连续重跑 prepare/finalize。

## 6. Smoke、登录排查与维护重启

登录请求的严格契约包含 `device_id` UUID：

```json
{
  "org_code": "local",
  "store_code": "main",
  "username": "<server-only>",
  "password": "<server-only>",
  "device_id": "<random UUID>"
}
```

缺少 `device_id` 与密码错误都按设计统一返回 401。Smoke 必须在受控进程内读取 0600 文件、
生成 JSON 并保存 token/cookie；只输出状态和固定断言，不能打印请求体、密码、token、cookie
或响应凭据。

排查 401 时先看服务端日志的 `reason_code`，不要放宽公网响应：

| `reason_code`           | 含义                                                                  | 处置                             |
| ----------------------- | --------------------------------------------------------------------- | -------------------------------- |
| `LOGIN_REQUEST_INVALID` | 请求没通过登录 schema，压根没到校验凭据这步（最常见是漏 `device_id`） | 修客户端请求体，不要动账号或密码 |
| `LOGIN_FAILED`          | 请求合法，凭据不匹配（org/store、用户名、密码、staff 未激活）         | 核对账号与密码                   |
| `LOGIN_RATE_LIMITED`    | 触发账号或 IP 限流                                                    | 等 `Retry-After`                 |

三者对外保持统一的安全响应；差异只存在于运维日志。`account_ref`/`ip_ref` 是 HMAC 后的不透明值：

```bash
journalctl -u laundry-desk --since "10 min ago" -o cat |
  grep -o '"reason_code":"[A-Z_]*"' |
  sort |
  uniq -c
```

维护前后统一检查：

```bash
curl --fail --silent --show-error https://desk.manpengan.xyz/health
curl --fail --silent --show-error https://kb.manpengan.xyz/healthz
```

`/var/run/reboot-required` 出现时，先确认 release `status` 为 `stable`，且没有构建、迁移或验收
进程；重启后等待严格 key-only SSH 恢复，再核对 PostgreSQL、Caddy、laundry-desk、KB、监听、
TLS、登录与 release marker。不得因 desk 恢复就忽略同机 KB，也不得在活动 transition 中重启。
