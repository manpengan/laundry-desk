# Laundry Desk Runtime Kit

`Laundry Desk Runtime.app` 是与柜台 Electron App 分离的 macOS 管理器。它只通过固定
argv 调用已探测到的 Docker CLI，管理本地 PostgreSQL 16 与 Server OCI 镜像；柜台 App
仍只探测 `127.0.0.1:8787`，不会安装、启动或停止 Compose。

## 安装态边界

- App bundle 内只有原生 arm64 可执行文件、digest-only Compose 模板和 Ed25519 公钥；
  不需要仓库、pnpm 或宿主 Node。
- `install --manifest /absolute/release.json` 从 stdin 读取严格 JSON setup，不接受密码或
  PIN argv/env。GUI 使用原生 `SecureField`。
- manifest 签名绑定 release/server/web、contracts major/hash、schema/migrations、
  multi-arch Server digest、PostgreSQL 16 digest、最低 App 版本和 nullable rollback 兼容元数据。
  rollback 字段当前只参与验签和兼容性校验；Runtime.app 没有 upgrade/rollback 命令。
  Docker 拉取后的 `RepoDigests` 必须精确包含签名的 multi-arch index 引用；arm64/amd64
  child digest 保留为签名发布元数据，不误当成本机 image inspect 返回值。
- 状态位于 `~/Library/Application Support/Laundry Desk Runtime/`；目录为 `0700`，状态、
  manifest 与 Compose secret 源文件为 `0600`。任何 symlink、hardlink、权限、签名或
  checksum 异常都会 fail closed。
- 安装中断保留 `prepared` 状态和四个 bootstrap 输入，供同一签名 manifest 幂等恢复。
  bootstrap、迁移、版本与健康门禁全部通过后，密码、PIN、用户名及显示名文件会在状态
  进入 `installed` 前删除并 fsync；常规 start/stop 不再需要这些输入。
- `stop` 只停 Server/PostgreSQL 容器，绝不删除命名 volume。数据库和照片两个外部命名
  volume 都由管理器显式创建并绑定 state/instance labels；install/recover/start/stop/
  diagnose 任一阶段发现缺失或标签漂移都会 fail closed，不会静默复用既有数据。

## 托管备份与恢复

- 入口只存在于原生 Runtime.app；柜台 Electron、Owner Web、HTTP、命令总线和 AI 均无
  备份/恢复权限。
- App 只读取自身 `backups/` 目录内生成的严格 backup ID。目录为 `0700`，manifest、
  PostgreSQL custom dump 与照片 tar 均为 `0600`；不支持外部导入、任意路径或删除。
- manifest 绑定 instance、release、Server/PostgreSQL 镜像 digest、migration head、schema
  hash，以及两个流式 artifact 的大小和 SHA-256。权限、hardlink、未知字段、哈希、格式或
  版本任一异常都会失败关闭。
- 恢复必须从 stdin 提交 backup ID 和界面显示的完整 `RESTORE-…` 确认摘要。Runtime.app
  会先停服并创建、验证预恢复安全点，再单事务恢复数据库、迁移/校验、恢复照片并过健康
  门禁；中途失败保留原备份和安全点且保持 Server 停止。
- 首期仅恢复同一 instance 且与当前已安装 release/schema 精确兼容的托管备份。自动轮换、
  外部导入、跨实例迁移与旧 release 升级恢复不在当前范围。

## 固定命令

```text
install --manifest /absolute/runtime-manifest.json   # setup JSON from stdin
recover --manifest /absolute/runtime-manifest.json
start
stop
restart
status
diagnose
launchd install
launchd uninstall
backup create                 # no stdin
backup list                   # no stdin
backup verify                 # {"backup_id":"..."} from bounded stdin
backup restore                # {"backup_id":"...","confirmation":"RESTORE-..."} from stdin
```

`diagnose` 只返回有界状态、release、migration head 和稳定故障码，不收集 secret、原始
容器日志或任意文件。LaunchAgent 使用 App 内绝对 canonical executable，输出定向
`/dev/null`，详细排查走显式 `diagnose`。

## 本地门禁

```bash
pnpm runtime:app:build
pnpm runtime:app:inspect
pnpm runtime:app:acceptance
pnpm runtime:app:lint:swift
node tools/runtime-kit/real-container-acceptance.mjs  # isolated real PG/photo drill
```

acceptance 将测试 App 复制到临时目录，在空工作目录和 `PATH=""` 下执行 install、restart、
签名篡改/兼容性负例、双 volume 篡改、故障注入、同 manifest recover，以及备份权限/哈希/
非法 ID/确认/互斥/成功恢复/失败安全点负例。测试 App 是原生 arm64 且可通过 ad-hoc
codesign 校验。V2 Foundation 的 macOS job 会持续执行 Swift lint 和这套 build/inspect/
no-repo 门禁；它使用仅测试构建信任的临时签名 key 和 fake runtime runner。

`real-container-acceptance.mjs` 不监听宿主端口，使用隔离的随机容器/volume 和解析后的镜像
digest，实跑 PostgreSQL custom dump/单事务 restore、照片 tar、安全点及损坏归档负例；它
只删除本次随机命名的验收资源。

当前已交付的是独立 Runtime.app 软件与无仓库生命周期门禁。XP-58 实体证据不属于本组件；
Apple Developer ID 签名/公证、正式 manifest 签名权威、已签名且可访问的多架构 OCI 产物，
以及 Runtime.app upgrade/rollback 都仍未交付。
