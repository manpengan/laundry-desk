# Windows 安装版与无源码 Runtime 实机接续

日期：2026-10-01。依据 ADR-66/67/68，接续
[独立安装生命周期](2026-09-13-windows-runtime-lifecycle-result.md) 与
[托管备份恢复](2026-09-30-windows-runtime-backup-restore-result.md)。
本次仅使用合成数据，状态为 **completed_local_qa · development_only**：
两项安装版 E2E、十场景 Runtime 维护 smoke 与原开发服务恢复均完成；正式发行与生产门禁另列。

## 基线与产物身份

- 干净主线基线：`83d8044e56107e2b723bf652702e6f0c76dfe7b3`，对应
  [PR #222](https://github.com/manpengan/laundry-desk/pull/222)。
  [CI run 36691826087](https://github.com/manpengan/laundry-desk/actions/runs/36691826087)
  已通过 Windows Runtime 的 20 个软件场景；目标 Windows 10 安装版证据仍单独记录。
- Windows 构建与测试采用独立 checkout，保留旧仓库的已有修改；不把旧工作区作为 clean main。
- 活动 V2 Counter 在该干净主线上构建。Electron `41.10.6` 的上游 SHA 校验、
  安装包构建与 inspect 已通过；安装器仍为 `NotSigned`。
- 安装器 SHA-256：
  `988608f510cb08972472db5b8af3c3f0c50f7a955145b73c23ff1d7abc831216`。
- 应用 EXE SHA-256：
  `1cd4d8447f81268da9c2dbbc7a1f10a6ed4e08c71b38b59718b3527e88109d73`。
- 安装后 `app.asar` SHA-256：
  `61268bb8b52477a8c47cf8e3d4c78c7371df47442b1b6a16015b58c02283413f`。
  安装后的 EXE 与 `app.asar` 均与 `win-unpacked` 内容一致。
- 安装后 51 个资源文件的完整清单与逐文件摘要均与干净构建一致；
  provenance SHA-256 为 `1236c78f7b1a8d611f6023d8122c0450af22999bf4422a35542d6772b4008b03`，
  其记录明确 `source_tree=clean`。
- Runtime 本地 QA 使用符合既有格式的标识 `0.1.0-win-dev.2026100102`；外部 manifest SHA-256：
  `4feaf349dcba5fdcc8cfd485058071c7e973f6e95b159ac727d08110ba0d93b2`。
  外部构建记录明确标记 `artifact_kind=local_qa_not_release`、`source_tree=uncommitted`：
  在上述主线基线上仅更改 launcher、host 与 release 标识；原主线 CI 分发物没有修改。
  该包属于本地 QA，不能称为 exact main、已通过 CI 的修复发行或正式 release。

## 实机发现与本地修复

首次 Runtime 安装在默认 `Restricted` 的 Windows PowerShell 5.1 环境失败。
launcher 清理注入环境时删除了当前进程的 execution policy，导致入口原有的 `-ExecutionPolicy Bypass`
在 dot-source 固定脚本前失效；失败发生在业务初始化之前。

本地修复先保存当前进程的 policy，仅恢复 PowerShell 支持的合法值；不改变主机或用户策略。
后续 Node 子进程仍使用受限环境，继续移除 Node、数据库及未知应用环境注入。
本次 QA payload 携带该 launcher 修复与下述任务 ACL 修复；源码回归验证与未提交状态分别记录，
不冒充主线证据。

首次 QA 准备使用了不符合既有 `win-dev` 格式的标识，持久化状态校验返回 `STATE_INVALID`；
当时尚未创建数据库、密钥或任务，失败 staging 保留并恢复既有开发服务 ready，随后改用上述合法标识，
没有放宽生产状态校验。

安装版 E2E 的本地凭据入口同时支持 companion 私有文件和既有私有 JSON，明确选择来源且不自动回退。
输入需通过有界读取、规范路径、私有 ACL 及链接检查；输入填充失败诊断与 Playwright 页面失败快照
不得泄露凭据。凭据值、主机侧定位信息和数据库内容不写入本记录，也不进入公开 artifact。

首轮 E2E 已在 Session 1、非提升令牌中执行，但登录页等待超时。SSH 安装入口此前返回 `running`，
连接结束后服务已不在运行且 health 不可用；后台进程随 SSH 执行上下文收回是当前推断，
不能把该短时 ready 计入业务可用。改用 companion 自带的 InteractiveLimited 登录任务启动常驻服务，
在新的 SSH 连接中复查 ready 后，再由 Session 1 中的 QA harness 执行安装版 E2E，最终结果已通过。

随后确认第二个安装缺陷：由提升权限的 SSH 上下文注册 companion 任务时，默认任务 SDDL 的 owner
为 Builtin Administrators，绑定用户仅有 `FR` 读取权限；Session 1 的 Limited 启动在禁用本任务的
步骤失败。本轮已取得任务 ACL 证据，修复已通过独立安全审查并进入上述本地 QA 包。
先严格匹配任务 metadata 与已有 ACL，再将 owner 固定为当前用户 SID，设置受保护的三条完整权限 ACE，
仅包含精确当前用户、SYSTEM 与 Builtin Administrators；以 `SetSecurityDescriptor` 的 flag `16`
写入后严格回读，principal 仍为 Limited。只有 `task-register` 可规范化已确认的旧 ACL，
inspect 与其他动作只检查、不写 ACL；未知 owner/trustee、deny/object/callback ACE、flags/masks 均拒绝。
Windows 新回归通过。最新 QA 的真实任务注册已核对当前用户 owner、受保护的三条 ACE 与 Limited
principal；安装入口已完成并返回 running。随后自带任务启动退出码为 `0`，health ready，
Node 与 PostgreSQL 均在 Session 1；另一独立 SSH 连接复查仍为 ready 且两类进程仍在 Session 1。
这关闭当前登录会话的常驻服务启动验证，不代表 OS 重启或重新登录后的恢复。

安装版 Runtime E2E 已在 11.4 秒内通过：打包身份、专用会话、DPAPI、固定 app origin、renderer 无 Node
权限、登录、关闭/重开恢复与退出均通过；本地目视实机 Counter 截图正常。
功能 E2E 首轮在工作台懒路由尚未显示标题时读取到空标题，并非尺寸断言失败；修正测试为先等待工作台
heading 可见，保留全部 viewport 断言后复跑。
PowerShell shell 的 `GetDpiForSystem` 返回值受其 DPI 上下文影响，不作为 Electron 的缩放证据；
修正后功能 E2E 已通过，1/1、约 1.1 分钟；最新两项安装版 E2E 的退出码均为 `0`，
QA task 为 Ready/result `0`，进程位于 Session 1 且 `elevated=false`。
功能断言覆盖十个导航面、账户切换、错误密码拒绝、双人复核、合成开单、部分收款、退款、取衣结清及重开。
六张截图已保存，本地目视工作台与已结清状态正常；`renderer_errors=0`、`server_failures=0`。
Electron 页面实测 `devicePixelRatio=1.5`、viewport `946×658`、`canScrollX=false`，
settings、topbar 与 title 均在 viewport，形成 150% DPI 的安装版证据。
长表单保留正常纵向滚动，sidebar 底部可随文档延伸；不把本次通过概括成所有页面零纵向滚动。

功能测试修正后的 Edge-agent 类型检查与该 spec 的 ESLint 均通过。
实机生命周期/备份 smoke 的 SQL 与只读核对已通过独立数据库审查；该 smoke 仅验证隔离 Runtime
的合成状态与维护行为，不计为全部业务数据完整性或离机灾备验收。
十个场景已全部通过：installed status、受控停止/启动/修复、自带任务启动、合成基线两行、
托管备份/列表/验证、备份后改写为三行并新增一张表、错误确认被拒且数据不变、原备份恢复为两行
且后建表不存在、安全点恢复到三行且后建表存在、最终再次恢复原备份为两行且后建表不存在。
最终 `lifecycle-result` 为 `status=passed`，10/10 全部 PASS，QA task 为 Ready/LastResult `0`，
四份托管备份保留，验证结束时服务 ready。

## 本轮验证结果

| 验证项                           | 本轮新鲜结果                                                                          | 证据边界                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 主线 Runtime 软件矩阵            | CI run `36691826087`，20 个场景通过                                                   | 主线软件证据，独立于本地 QA 修复                                                  |
| Counter 构建、inspect 与上游摘要 | 已通过，`NotSigned`                                                                   | 干净主线构建，未取得签名或 pilot 准入                                             |
| Windows 用户级安装               | 安装器退出码 `0`                                                                      | 已安装；业务登录与会话恢复另验                                                    |
| 安装后的完整资源检查             | 51 个文件数量及逐文件摘要与干净构建一致                                               | EXE、SPA 与完整清单均绑定上述 provenance                                          |
| 前一 QA Runtime inspect / smoke  | 6427 个文件、原生模块与无源码加载通过                                                 | 前一仅含 launcher 修复的 QA；不代替最新 host 修复包验收                           |
| 最新 QA Runtime inspect / smoke  | 6427 个文件、原生模块与无源码加载均通过                                               | 绑定最新 `4feaf349…` QA manifest                                                  |
| Windows 完整相关专项回归         | 80 项：79 通过，1 个 POSIX 专项跳过，0 失败；17.9 秒                                  | Windows Runtime、launcher、host 及凭据检查                                        |
| Windows 任务 ACL 新回归          | 1/1 通过                                                                              | 合成 ACL 校验，未操作真实 Task                                                    |
| 本地相关专项回归                 | 80 项：75 通过，5 个 Windows 专项跳过，0 失败                                         | Windows 专项另由实机回归补齐                                                      |
| 任务 ACL 修复独立安全审查        | 已通过                                                                                | 不代替真实 Task 与 Session 1 验收                                                 |
| Edge-agent 完整类型检查          | 已通过                                                                                | 当前本地变更源码验证                                                              |
| Edge-agent 完整测试              | 88 个 scripts + 425 个 dist 测试，共 513 项全部通过                                   | 当前本地变更源码验证                                                              |
| SPA verify、构建与类型检查       | 已通过                                                                                | 同一构建与当前源码检查                                                            |
| 改动 TS/MJS lint 与格式检查      | `max-warnings=0` 与 Prettier 均通过                                                   | 当前本地变更源码验证                                                              |
| 前一 QA Runtime 实机安装         | 安装完成；SSH 入口短时 running，Session 1 启动暴露旧任务 ACL 缺陷                     | 已受控停止并完整保存实例                                                          |
| 最新 QA Runtime 实机安装         | 安装完成并返回 running                                                                | 最新 QA manifest、基线源码、迁移头 `0069_bounded_automation.sql`；常驻 ready 另验 |
| 最新 QA 实际任务 ACL             | 当前用户 owner、Protected、三条 ACE、RunLevel Limited 已核对                          | 真实 Task 元数据证据                                                              |
| Session 1 常驻服务启动           | 自带任务退出码 `0`；health ready；Node/PostgreSQL 均在 Session 1，跨独立 SSH 复查保持 | 当前真实登录会话通过；没有执行 OS 重启或重新登录验收                              |
| Runtime 实机启停与修复           | installed status、受控停止/启动/repair、自带任务启动均通过                            | 本页最新 QA、当前真实登录会话                                                     |
| 安装版 Electron 登录与重开恢复   | 1/1 通过，11.4 秒；截图本地目视正常                                                   | 打包身份、DPAPI、固定 origin、无 renderer Node、登录/重开/退出                    |
| 安装版功能旅程与布局             | 1/1 通过，约 1.1 分钟；renderer/server 错误均为 0；六张截图保存并目视核对             | 十导航、账户/复核与合成业务主链；Session 1 非提升令牌                             |
| 安装版 150% DPI                  | DPR `1.5`，viewport `946×658`，无横向滚动，settings/topbar/title 在 viewport          | 长表单可正常纵滚，不声称所有页面零纵向滚动                                        |
| 托管备份与首次确认恢复           | backup/list/verify、错误确认拒绝且数据不变、原备份恢复两行且后建表消失均通过          | 同实例/迁移/PostgreSQL、照片为空的隔离维护 smoke                                  |
| 安全点恢复与再次原备份恢复       | 已通过：安全点三行且后建表存在，最终原备份两行且后建表消失                            | 十场景全部 PASS，四份托管备份保留，验证结束服务 ready                             |
| QA 收尾与原开发服务恢复          | 已完成，独立 SSH 最终复查通过                                                         | QA 停止并保留，四份备份保留；原服务 ready；未改变机器/用户 policy                 |

故障注入 CI 矩阵没有直接运行到已有用户实例。
测试期间按原有受控入口识别和停止已绑定服务，不删除原有数据，也不绕过任务、版本或维护权威。
切换最新 QA 前，前一 QA 实例已受控停止并完整保留，未删除数据库或密钥；既有开发服务已恢复 ready，
随后按受控入口切换至最新 QA 独占固定端口。收尾已受控停止 QA，状态为 `stopped_preserved`，
数据库与四份托管备份全部保留；companion 任务已禁用，自建手动 QA 任务已移除。
原 development 任务恢复 Running，API 与 PostgreSQL 均位于 Session 1，health 精确返回
`ok=true`、`data.status=ready`；原私有 handoff 摘要与基线一致，旧仓库 HEAD 仍为
`d3d04598fc430b34b89b55b4fa3e28dbef4ae358`。

独立 SSH 最终复查再次确认上述 health ready、原 development 任务 Running、companion 禁用、
自建 QA 任务数量为零。PowerShell 的 MachinePolicy、UserPolicy、Process、CurrentUser、LocalMachine
均为 Undefined；机器与用户策略未改变。恢复记录已安全保存到本地私有临时目录。

## 尚未关闭的门禁

本地修复尚未提交、推送或合并，尚未形成对应修复 SHA 的 CI 与发行证据。
Windows 11、中文 IME、系统重启后的真实登录恢复、三类实体热敏打印、Authenticode、宏发现场演练仍单独验收。
不同迁移的程序/数据库联合升级、照片联合恢复、跨实例导入和加密外部导出仍未交付。
ADR-65 的独立生产候选、离机恢复、告警、容量、数据责任与真实顾客准入仍需各自外部证据；
本次安装包和 QA 恢复结果不授权真实运营。
本轮常驻服务与安装版 QA harness 均使用真实 Session 1；SSH 入口的短时 ready 不构成可用证据。

## 后续开发顺序

1. 先将本轮 execution policy 与任务 ACL 两项安装修复形成可审查变更，运行对应源码 SHA 的 CI，
   再以其 exact manifest 补齐目标机证据。目前未取得 Git 操作授权，故不提交、推送或合并；
   本地 QA 成功不能替代这一交付步骤。
2. 完成 Windows 11、OS 重启/重新登录后的服务与会话恢复、中文 IME，并以 Electron 实测指标记录 DPI。
3. 接入目标 XP-58 与其余规定打印机，实证中文、金额、条码、走纸、切刀、断连、补打和重复保护；
   完成签名或受控内部发行裁决，再执行真实目标机第二版本升级/回滚。
4. 独立关闭 ADR-65 的生产候选、离机恢复、告警、容量、迁移与数据责任门禁，之后才进入宏发真实数据准入。
