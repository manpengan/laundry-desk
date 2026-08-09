# Laundry Desk Runtime Kit

`Laundry Desk Runtime.app` 是与柜台 Electron App 分离的 macOS 管理器。它只通过固定
argv 调用已探测到的 Docker CLI，管理本地 PostgreSQL 16 与 Server OCI 镜像；柜台 App
仍只探测 `127.0.0.1:8787`，不会安装、启动或停止 Compose。

## 安装态边界

- App bundle 内只有原生 arm64+x86_64 universal 可执行文件、digest-only Compose 模板和
  Ed25519 公钥；
  不需要仓库、pnpm 或宿主 Node。
- `install --manifest /absolute/release.json` 从 stdin 读取严格 JSON setup，不接受密码或
  PIN argv/env。GUI 使用原生 `SecureField`。
- manifest 签名绑定 release/server/web、contracts major/hash、schema/migrations、
  multi-arch Server digest、PostgreSQL 16 digest、最低 App 版本和 nullable rollback 兼容元数据。
  upgrade 要求新清单的 rollback target 精确绑定当前 release/image/schema；本地状态持续保留
  已接受最高版本与前一清单摘要，不能被新清单调低安全下限。
  Docker 拉取后的 `RepoDigests` 必须精确包含签名的 multi-arch index 引用；arm64/amd64
  child digest 保留为签名发布元数据，不误当成本机 image inspect 返回值。
- 状态位于 `~/Library/Application Support/Laundry Desk Runtime/`；目录为 `0700`，状态、
  manifest 与 Compose secret 源文件为 `0600`。任何 symlink、hardlink、权限、签名或
  checksum 异常都会 fail closed。
- 安装中断保留 `prepared` 状态和两位管理员的八个 bootstrap 输入，供同一签名 manifest
  幂等恢复。两组用户名、密码和 PIN 必须分别不同；密码为 12–256 位，PIN 为 6–8 位数字。
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

## Runtime 托管 LAN

- Runtime.app 是正式安装态唯一 LAN 运维入口。它用 manifest v2 的
  `lan_compose_sha256`/`owner_spa_sha256` 校验签名 Server OCI、Compose overlay 和内嵌
  Owner SPA；v1 manifest 只能继续运行回环服务，不能启用 LAN。
- `lan configure` 只从不超过 32 KiB 的 stdin 或 GUI 内存读取精确 JSON：
  `{bind_ipv4,port,certificate_pem,private_key_pem}`。地址必须是当前活动物理接口上的 RFC1918
  IPv4，端口必须是非 8543/8787 的显式高端口，证书必须有效且 IP SAN/私钥匹配。
- 私有状态位于 `lan/state.json` 与 `lan/generations/<generation>/`；generation 精确包含
  `certificate.pem`、`compose.env`、`config.json`、`private-key.pem`、`profile.json`，目录
  为 `0700`，文件为 `0600`。任何未知字段、链接、权限或摘要漂移都会失败关闭。
- `disable` 只移除 gateway，不停止回环 Server；之后直接 `enable` 以及重新配置后再启用都
  必须恢复工作。失败启动会清除 gateway 并保持 disabled，不会留下“已启用”假状态。
- gateway 的 Compose healthcheck 使用 OCI 内固定 Node 探针：连接 `127.0.0.1`，但以公开
  LAN IP 做 TLS 身份和 Host 校验，严格使用配置证书为 CA，并限制超时、响应大小和状态码。
  `up --wait` 之后还会验证受信 `/health` 与 `/owner`。
- `support create` 写出 `support/runtime-support.json`：单个 `0600` 严格 JSON，不超过
  256 KiB；只含 Runtime、Server、LAN、备份和打印的稳定码、版本、计数与布尔值，不含日志、
  路径、PEM、环境、顾客/订单/员工字段或凭据。

## 固定命令

```text
install --manifest /absolute/runtime-manifest.json   # setup JSON from stdin
commission                       # legacy second-admin setup JSON from stdin
recover --manifest /absolute/runtime-manifest.json
upgrade --manifest /absolute/runtime-manifest.json   # no stdin
rollback                         # {"confirmation":"ROLLBACK-<target release>"} from stdin
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
lan configure                 # exact bounded profile JSON from stdin
lan enable                    # no stdin
lan disable                   # no stdin
lan status                    # no stdin
lan onboard                   # no stdin
lan diagnose                  # no stdin
support create                # no stdin
```

`commission` 只用于迁移后的既有单管理员门店：Runtime 在维护锁内通过私有 secret file 调用
owner-only 容器服务，精确校验尚未投产且仅一位 active admin 后，原子补齐第二审批管理员、
feature profile、投产标记和无秘密审计。成功后入口永久关闭；柜台 Server/Web/AI 不暴露该权限。

upgrade 在维护锁内停服，先创建并验证 `pre_upgrade` 安全点，再切换签名 manifest、迁移并执行
完整健康门禁；任一步失败会自动恢复原 manifest 与安全点，恢复成功后才重新启动旧 release。
rollback 只允许一步回到签名绑定的 previous release，先保留 `pre_rollback` 安全点，再恢复
对应 `pre_upgrade` 快照；失败保持停服并保留两个安全点，不会跳版本或降低最高已接受版本。
每次切换先以 `0600` transaction 绑定切换前后的 state、history、当前/前一 manifest 与安全点；
进程在任一原子写边界中断后，会在严格加载正常状态前恢复切换前安全点并清理 transaction。

`diagnose` 只返回有界状态、release、migration head 和稳定故障码，不收集 secret、原始
容器日志或任意文件。LaunchAgent 使用 App 内绝对 canonical executable，输出定向
`/dev/null`，详细排查走显式 `diagnose`。

## 本地门禁

```bash
pnpm runtime:app:build
pnpm runtime:app:inspect
pnpm runtime:app:acceptance
pnpm runtime:app:lint:swift
pnpm runtime:lan:container:acceptance
node --test tools/runtime-kit/*.test.mjs
node tools/runtime-kit/real-container-acceptance.mjs  # isolated real PG/photo drill
```

acceptance 会先强制 `lipo` 同时存在 arm64/x86_64，再将测试 App 复制到临时目录，在空工作
目录和 `PATH=""` 下执行 install、restart、
签名篡改/兼容性负例、双 volume 篡改、故障注入、同 manifest recover，以及备份权限/哈希/
非法 ID/确认/互斥/成功恢复/失败安全点负例。测试 App 是原生 universal 且可通过 ad-hoc
codesign 校验。`runtime:app:acceptance` 只构建、检查一次 App，随后依次执行原 Runtime 与 LAN
的无仓库门禁。V2 Foundation 的 macOS job 会持续执行 Swift lint 和这套门禁；它使用仅测试
构建信任的临时签名 key 和 fake runtime runner。

`runtime:lan:container:acceptance` 是本机最终集成门禁：构建真实 Server OCI，在唯一 project、
volume 和临时目录中启动 PostgreSQL/Server/gateway，验证受信 HTTPS、Host/Origin/Forwarded/
命令拒绝、8787/8543 的 LAN 隔离、两个浏览器上下文、disable→enable 与重新配置生命周期，
最后断言所有验收资源已清理。它需要 Docker、真实物理 RFC1918 地址和 Playwright，不放入
GitHub macOS required job；CI 持续执行的是确定性的无仓库 Runtime/LAN 门禁。

## 正式 manifest 与 macOS 发布入口

`runtime:manifest:generate` 只接受四个 canonical absolute 文件路径环境项，不接受 argv：

```text
LAUNDRY_RUNTIME_MANIFEST_INPUT_FILE
LAUNDRY_RUNTIME_MANIFEST_PRIVATE_KEY_FILE
LAUNDRY_RUNTIME_MANIFEST_PUBLIC_KEY_FILE
LAUNDRY_RUNTIME_MANIFEST_OUTPUT_FILE
```

三个输入文件必须是 `0600`、单硬链、canonical real file；生成器通过 no-follow fd 在读取前后
复核类型、权限、大小、device/inode 与 mtime。payload 必须与原生 verifier 完全同构；生成器
校验 Ed25519 公私钥匹配、精确字段、OCI 双架构摘要、schema/rollback 兼容边界，并以
create-only 方式输出签名 envelope。测试每次使用 ephemeral Ed25519 key，不签入或模拟正式私钥。

`runtime:release:mac` 要求以下非 secret 值或仓库外路径；认证 secret 只能预先保存进指定
Keychain/notarytool profile：

```text
LAUNDRY_RUNTIME_CODESIGN_IDENTITY
LAUNDRY_RUNTIME_APPLE_KEYCHAIN
LAUNDRY_RUNTIME_NOTARY_PROFILE
LAUNDRY_RUNTIME_MANIFEST_PUBLIC_KEY_FILE
```

入口使用固定无 shell argv 和白名单子进程环境，构建 universal App，强制 inspect 后执行
Developer ID hardened-runtime 签名、ZIP 公证、App staple、DMG 签名/公证/staple 与 Gatekeeper
检查；输入公钥沿用上述严格 fd 规则。发布前的 App 全树、ZIP 与 DMG SHA-256 seal 必须与已验证
产物一致，bundle id/version/build/team 也必须匹配固定契约，才原子写入
`tools/runtime-kit/dist/release/`。最终 rename 是明确提交点，之后的暂存清理异常只报告
`cleanup=pending`，不会伪报产物未发布。缺少任何输入会在执行外部命令前失败关闭。

`real-container-acceptance.mjs` 不监听宿主端口，使用隔离的随机容器/volume 和解析后的镜像
digest，实跑 PostgreSQL custom dump/单事务 restore、照片 tar、安全点及损坏归档负例；它
只删除本次随机命名的验收资源。

当前已交付的是独立 Runtime.app 软件、universal 构建与无仓库生命周期门禁，以及正式发布
和 manifest 的失败关闭工具链。XP-58 实体证据不属于本组件；真实 Developer ID 签名/公证
记录、正式 manifest 私钥权威、已签名且可访问的多架构 OCI 产物仍是外部门禁，不能由
ephemeral-key 或 ad-hoc 测试替代。
