# Windows Runtime companion 后续交付计划

日期：2026-09-12。依据 [ADR-67](../../adr/2026-08-30-adr-67-windows-native-local-runtime.md)、
[ADR-66](../../adr/2026-08-29-adr-66-windows-hongfa-pilot.md) 与
[ADR-65](../../adr/2026-08-25-adr-65-cloud-production-baseline.md)。本计划不新增业务 Command/Query，
不改变 loopback 拓扑，也不授权真实数据准入。

## 当前边界

- 依赖审计修复 PR #216、Stage 5.1 外部输入登记工具 PR #217 已合入 main；外部资产仍需实际提供。
- 既有 Windows 开发 Runtime 依赖源码仓库和系统 Node；它的开发验收不能证明独立安装完成。
- 独立 payload PR #218 已合入 main（`ce7fbef`），对应 PR 头的 workspace、真实 PostgreSQL、Windows
  payload 与 macOS Runtime 四项检查通过；这关闭无源码加载门禁，不代表独立安装成功。
- 安装生命周期接续记录见[2026-09-13 验证记录](../../operations/2026-09-13-windows-runtime-lifecycle-result.md)。
- 当前环境未找到构建机手册引用的 `windows-lan-ssh` 私有工具。GitHub Windows Server 2022
  能执行软件门禁，不能替代目标 Windows 10/11、中文输入、DPI、设备出纸与现场性能证据。

## 1. 关闭 payload 门禁

1. 固定源码 SHA、锁文件、Node/EDB archive SHA；构建前后核对源码身份。
2. 在 Windows PowerShell 5.1 上实际解压两个固定 ZIP；畸形路径、链接、碰撞和超限归档失败关闭。
3. 在源码仓库移走后，使用包内 Node 加载 Server、Sharp、Argon2，核对同一迁移摘要。
4. 保存 CI run、源码 SHA、外部 manifest SHA 和 artifact 引用；证据只称 `development_only`。
5. 完整 workspace、真实 PostgreSQL、macOS Runtime 与 Windows payload 同一 PR 头全部绿灯后合并。

## 2. 实现独立安装状态机

安装器与 launcher 独立于 Electron。先拆出有界职责模块，再复用同一 roles/migrate/bootstrap/verify
入口；不复制业务初始化 SQL，也不继续扩大旧的开发安装脚本。

固定安装根位于当前用户 LocalAppData，独立于旧 `development-runtime`。不得自动接管旧开发 cluster、
同名未知任务或占用端口的未知进程。发行目录与可变数据/密钥分离；所有权和受保护 DACL 由已验证 helper
创建并复核。安装器默认只处理合成数据，不提供删除数据库/密钥动作。

| 状态/动作                      | 提交条件                                                                       | 失败与重入行为                                                   |
| ------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| absent → staged                | 外部摘要绑定、完整 payload 校验、私有目录与独占操作锁                          | 不发布指针；只清理本次已确认身份的 staging                       |
| staged → initialized           | cluster checksums/SCRAM/UTF-8、随机独立密钥、角色/迁移/bootstrap/verify 全通过 | 保留数据与密钥；半初始化状态明确阻断，禁止覆盖重建               |
| initialized → stopped          | 当前版本记录持久化、任务身份与固定入口复核                                     | 未提交状态不得登录自启；重入读取并验证持久化状态                 |
| stopped → running              | 包摘要、私有文件、迁移 ledger、两个 loopback listener 与健康身份全部符合       | 禁止以任意 `/health` 的 ready 冒充本版本；失败保持不可写         |
| running → stopped              | 暂停自启、核对 Server 身份、先停止 Server、再 `pg_ctl fast`、确认端口退出      | 禁止 Task Scheduler hard terminate；失败不得发布新版本           |
| stopped → upgraded/rolled_back | 新旧迁移 head 与聚合摘要一致、旧版完整保留、新版 verify 通过                   | 失败返回已验证旧版；迁移变化先阻断，另走备份/数据库联合恢复      |
| stopped → uninstalled          | 已确认本安装任务和进程退出                                                     | 只注销本安装任务及移除已绑定程序文件；保留数据库、密钥和恢复记录 |

版本指针采用唯一临时文件、私有 ACL、文件 flush、helper 写穿透替换、父目录 flush。不能把 helper
的 `replace-file` 单独当成源文件已经刷盘。提交前/中/后崩溃必须恢复为完整旧版或完整新版；不得指向
半写文件。操作锁须覆盖安装、升级、回滚、停机与卸载，不能用多个独立脚本间的时间假设代替互斥。

launcher 使用固定包内 Node 和绝对入口，清除 Node 注入、数据库直接 URL、未知 PG/LAUNDRY 环境，
只注入经核对的私有 `*_FILE` 路径及固定版本/迁移身份。凭据不能进入命令行、普通日志或 CI artifact。
`pg_ctl` 隔离继承输出句柄并仅等待直接子进程，沿用 ADR-67 的后台进程限制。

## 3. 独立生命周期验收

在一次性 Windows CI 用户目录创建合成 cluster；撤走仓库并从 PATH 排除系统 Node/pnpm，顺序执行：

1. 新安装、真实 roles/migrate/bootstrap/verify、health 版本/迁移身份核对；
2. 停止、重启、重复安装/修复；重启后数据计数和 secret 摘要保持；
3. 同迁移第二版本升级、回滚；篡改包与不同迁移版本被拒绝；
4. 注入目录刷盘/替换/指针提交失败、进程中断、任务冲突、端口冲突和并发操作；
5. 卸载后无本安装进程/任务，数据与 secret 摘要不变；重装可恢复同一合成数据状态。

每个场景报告阶段、稳定错误码、版本 SHA、迁移摘要、非秘密计数与时间。CI 清理仅针对该次临时测试
身份；生产卸载不复用测试销毁逻辑。通过后再执行目标 Windows 10/11 的无源码实机安装与重启验收。

## 4. 外部输入与现场记录

以下均尚未取得本轮可核验输入。责任人提供非秘密 `asset:`、`document:`、`owner:` 或 `ticket:`
引用；密码、私钥、数据库 URL、顾客字段和票据内容不得提交仓库。

| 所需输入                                                           | 责任/证据                                              | 解锁动作                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------ |
| Windows 构建机/目标机的既有接入工具与权威文档位置                  | manpengan 提供；固定 host identity、受控账户、系统版本 | 按原手册执行开发安装与 GUI 实机验收              |
| XP-58 与另外两类现役打印机型号、端口、现场操作员                   | 设备 owner 与现场记录引用                              | 中文/金额/条码、走纸、切刀、断连、补打与重复保护 |
| Authenticode 来源或受控未签名内部发行裁决                          | 产品裁决引用、包摘要、目标机器范围                     | 明确可分发的 development/pilot 边界              |
| 独立 production-candidate、DNS/TLS、owner 与动作授权               | Stage 5.1 environment 全部引用                         | 登记固定第二 profile，之后按精确授权执行主机动作 |
| 离机介质、独立故障域、加密证据与 owner                             | Stage 5.1 offsite 全部引用                             | 真实离机恢复演练                                 |
| 告警接收端、receipt/clear 契约与 owner                             | Stage 5.1 alerting 全部引用                            | 真实告警送达与解除回执                           |
| 获批准容量画像、API/UI 阈值                                        | Stage 5.1 capacity 全部引用                            | 容量准入，不能用任意压测数字代替产品阈值         |
| 试点两位独立管理员、数据责任、停止条件；如需迁移，授权只读备份引用 | 产品/数据 owner 与切换手册                             | 零差异迁移演练及最终真实数据准入复核             |

四类生产输入按 [Stage 5.1 登记约束](../../operations/2026-08-28-stage51-external-input-gap-result.md)
进入**新的** canonical register，保留 8 月 28 日历史记录。引用格式通过不等于资产或授权真实性通过。
未取得这些输入时仍可推进安装器与合成数据 CI；不得把 `hk-vps-cloud-test` 改称生产候选环境。
