# 实施进度

## 2026-10-06

- 主线刷新至 10b55c8e；PR232 已合并；PR233 614b423c 四项 CI 已通过。
- 当前隔离分支 codex/ui-ux-remediation-20261005，原工作区及 Claude 工作区保持原样。
- main 合入修复分支中；ReceiveTicketResult 冲突保留扫码收款和衣物明细两方行为，SPA 重新生成。
- 审查清单 28 项全部登记；代码实现与外部/实机/准入证据分别关闭。

2026-10-06：第一轮业务优化并行实现。D01/D02/D03代码复核未见阻断。扫码pending离页后异步付款已加完成页order.get权威核对，失败禁止再扫码。D04安全复核发现首次401后再次请求丢响应会遗留旧失败receipt；已修prepare重发前清失败回执，独立复现变为sameKey=true/receipt=null/NEW_OPERATION_BLOCKED，13/13回归通过。D05 migration0081已应用隔离本机PG（localhost8543）；151条差异、并发CAS、跨租户与审计回滚、全店导出2/2真实PG通过。根Web相关10/10通过。D08复核提出多同价品名身份与空白名称边界，正在修。V2安装CI已添加（generic/hongfa），不作为已通过证据。WindowsSSH已确认可连，C:/dev/laundry-desk含大量既有改动，保持不动；最终构建需新隔离目录。

2026-10-06 整合验证：Windows SSH 确认 Microsoft Windows 10 Home 中文版 build19045、Session1已锁，向日葵DESKTOP-MAN离线；新建 C:/dev/ld-remediation-20261006 隔离checkout，原目录不动。D08真实PG/新库迁移/完整workday通过，D06真实PG分页51条/旧结清/客户历史/待取/RLS通过。D07/U08独立安全复审45/45+5种会话竞态拒绝，无确认阻断漏洞；补全release包D04文件。workspace首轮格式lint类型通过，两个测试清单随新CI定义需更新，32项回归已通过。28浏览器首轮21通过7失败：6个设置分区旧导航，1个固定通知样本重复；修测试并继续回归。全套PG首轮1304通过、1原生平台skip、1测试环境注入软件通知导致单测预期差异，私有runner去除该UI专用环境后重跑。以上失败均保留原始日志，不计为完成。

### 本地整合复验完成

D01–D08、U01–U08 的软件实现均已完成；本次整合后的新鲜结果如下。早期失败日志保留，以下通过只对应修正后的运行。

| 检查                        | 结果                                    | 证据 / 限定范围                                                                                                 |
| --------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `workspace:check` 第 4 轮   | 退出码 0                                | `/private/tmp/ld-final-workspace-check4.log`；format、lint、类型、单元/foundation/Runtime 测试、构建全链通过    |
| 浏览器完整 E2E 第 2 轮      | 28/28 通过，37.1 秒                     | `/private/tmp/ld-final-browser-e2e2.log`；隔离 PostgreSQL 合成业务旅程，含短/窄窗口、设置、原操作重试及员工切换 |
| 独立新数据库完整测试第 2 轮 | 1306 项：1305 通过、1 跳过、0 失败/取消 | `/private/tmp/ld-final-full-pg2.log`；唯一跳过是 Windows 原生 DPAPI，不记为通过                                 |
| D06 独立 PostgreSQL 分页    | 1/1 通过                                | 51 条分页、历史结清单、客户历史、待取与 RLS 边界                                                                |
| 独立复审回归                | 17/17 通过                              | TypeScript 与安全复审未发现确认的阻断问题；不等同完整形式化安全证明                                             |
| V01 安装 CI                 | 已编写，类型/lint 通过                  | generic/hongfa 安装来源检查与安装后用例就绪；远端 CI/Windows 执行尚未确认通过                                   |

完整数据库测试在 Node 25 下产生 `spec` 格式原始日志，与现有严格 TAP 解析器不兼容。
上表引用原始运行的测试摘要与成功退出；**未宣称严格 TAP 解析器已经通过**。

本次未把原 Windows 安装版或旧 Runtime 的结果移用于新代码。Windows Session 1 仍锁定、向日葵离线；
当前准备同 SHA 的隔离构建，以及可恢复原开发服务的受控切换，尚无本次安装态通过结论。
同源 Counter/SPA/Runtime/迁移/安装器绑定、Windows 证据与提交推送/远端 CI 将在各自完成后记录。

ADR-98 与本机准入手册已准备，状态为 Proposed，待 manpengan 签署。
V02–V08 的跨机器/用户、长期运行、实际签名与安装回退、目标 OS 生命周期、店长 GUI、真实渠道/设备、
真人与辅助技术证据仍分别待补；自动化通过不授权真实数据或真实交易。

O01 全店图像找衣与 O02 自动拉取支付账单沿用原审查中的可选新需求分类。
本轮范围异步澄清超过 60 秒未获回答，按已说明的默认范围不纳入本轮；未实现，不计为完成或交付。

### 提交与 CI 接续（2026-10-06 02:23，Asia/Taipei）

- `2dad7cd1` 已整合 main `10b55c8e` 并推送，实现 D01–D08/U01–U08，SPA manifest SHA-256 为 `a562523bbde436fd8f568bc3966da73c6c4da68132bfb9fe0e4d79e6383a9fc8`，45 项完整性检查通过。
- `70ba498f` 修正全新 checkout 的 server 构建依赖；无 dist、无缓存类型检查 6/6。该版本 [Foundation CI](https://github.com/manpengan/laundry-desk/actions/runs/37351534464) 已通过，含 workspace 与 macOS runtime。该版本两项 CI 失败保留原记录，不计通过。
- `a330cad9` 固定 PowerShell 系统签名模块、关闭 stdin、顺序查询并增加有限诊断；保留签名拒绝策略。联合回归 19/19，独立复核 7/7。Windows 本机对实际 CI app/installer 分别 1015ms/484ms 返回 `NotSigned`，本机结果不替代候选 CI。
- 安装态恢复用例改验可见界面，并在应用关闭期间独立补缴 500 分；重启需核对原票号、衣物及应付/已付/欠款 1500/500/1000 分。类型、lint 与合成 HTTP 夹具通过，完整 Windows 用例结果另验。
- 远端 fresh commissioning 发现测试仍按旧导航寻找会员及交班面板。Web/Mac 两份测试各补五行显式导航，全部闭环断言保留；类型、lint、格式与独立复核通过。官方独立空卷 Browser commissioning 1/1，后续客户/工厂/会员/通知 4/4，退出 0。日志 `/private/tmp/ld-commissioning-nav-acceptance.log`；原 QA 按原容器 ID 恢复，PG healthy、API ready。Mac 对应完整打包用例本轮未重跑。
- Windows 隔离构建当前为 `70ba498f`，此后仅验收/CI 工具变更。首轮 Runtime 生产依赖 deploy 超时，未产生可验收安装包；离线供应链校验已通过，正式构建重试中。原 Windows 服务尚未切换，Session 1 仍锁定。

最新远端运行、候选 Windows 结果与证据索引在 [PR #233](https://github.com/manpengan/laundry-desk/pull/233) 继续记录。
后续只改测试、CI 或记录时仍分别列明源码 SHA；不得把不同 SHA 写成同一安装包，也不得将失败或待执行写成通过。

### 视觉复查与安装验证接续（2026-10-06 02:47，Asia/Taipei）

`3723c26e` 的 Foundation（workspace 与 macOS Runtime）和 Windows Counter 双 profile CI 均已通过。
Counter 各有安全 smoke 与登录/订单/重启恢复两项，共 4/4；其实际安装来源为 GitHub PR 合成提交 `c2a44ea7`。
同工作树官方 Mac 开发包独立空卷 commissioning 1/1 通过，测试前后 app SHA-256 均为
`4a638daf39267a22ae46ec0cff0fd93f5e7040c0c53b286e043efce6f37a56d9`；使用 mock keychain，不能替代原生安全存储验收。

追加 Web 视觉取证发现 640–680px 顶栏横向溢出：639px 已换行，640px 却仍采用不换行规则。
640×700 实窗的 `clientWidth=629`、`scrollWidth=674`，切换员工按钮被截断。
将已有窄屏规则的上限改为 767px 后，640px 实窗 `scrollWidth=clientWidth=629`；
639/640/700/767/768/900/1024 七种宽度、浅深色和全部四个顶栏按钮均通过边界检查，结算确认可达且不覆盖字段。
新用例连同原结算/设置回归 3/3；格式、lint、E2E 类型、Web 构建与 SPA 45 项完整性通过。
8 张取证图及修前/修后状态保存在 `output/project-remediation-20261006/web-visual/visual-review.json`，图 03 为修前失败证据。
这次 CSS 与 SPA 已变化，后续 Windows 候选必须更新，不能再称 `70ba498f` 与最终产品完全相同。

Windows 实机 `70ba498f` 两轮构建均在 Runtime deploy 阶段超时，未生成可验收候选包，原服务未切换。
独立部署探针关闭 stdin 后 5.4 秒成功，但随后保持 stdin 打开的对照也在 5.6 秒自然退出；
因此未把 EOF 当作已证实根因，也未据此修改构建器。正在比较输出目录与 pnpm lifecycle 环境。
实际安装态、原生交互及长期/外部准入门禁继续保留未验状态，最新结果以 PR #233 的精确 SHA 记录为准。

### 最终候选测试同步（2026-10-06 03:08，Asia/Taipei）

- `27b37191` 的 Windows Counter 双 profile CI 已通过（4/4），PR 合成源码 `a90b7d2715f363743efb733f01a2012072900036`，新 SPA `bf5e0810c4da07cd3a873d92ef74e7e62c285fa23aee5ef5efd14a457f027151`。
- 该版本 Foundation 的 contracts 用例一次 OpenAPI 生成耗时 5112ms，超过默认 5000ms；同文件另两次重复生成分别约 4742/3849ms。改用既有 `beforeAll` 10 秒约定生成一次，只读共享，全部断言保留。定向 14/14、完整 contracts 856/856（含 coverage 与 m2-freeze）、类型/lint/格式通过，独立复核无阻断；未改生产生成器或全局超时。
- 中间 `3723c26e` 的 PostgreSQL CI 在浏览器会员取衣回执处失败，27 通过/1 失败。服务日志显示此前没有发出取衣命令；本地原用例重复 3/3、诊断全套 29/29 均未复现，不能声称精确触发原因已查明。只修测试同步：等待自动加载，手工重查后校验目标请求/唯一订单、加载完成、应收 10 元及选中一件衣物，再执行取衣。取衣/积分断言和超时保留，修后单文件连续 3/3、类型/lint/格式及独立复核通过。未改产品或再次生成 SPA。
- Windows 部署探针已确认：内部目标目录重写本地依赖相对路径，改变派生锁文件与校验缓存命中；网络请求等待造成正式部署超时。仅本进程设 `fetchRetries=0`、`fetchTimeout=10000` 后，内部目录部署 16.05 秒完成，156 项供应链重新校验全部通过。没有关闭策略、修改构建器或伪造通过缓存。
- 实机存在 `57e6def1` 宏发安装，尚未覆盖。正式候选安装前须隔离 NSIS 目标并备份/恢复本应用注册入口、快捷方式及更新缓存；原程序目录、用户数据和开发服务保留。最终构建、安装态业务与恢复结果仍另记。

### Windows 连续打包修正（2026-10-06 03:23，Asia/Taipei）

`27b37191` 的 PostgreSQL CI 已通过：fresh commissioning 1/1、真实 PG server 1305 通过及 1 项平台跳过、Windows 数据维护 4/4、Web 29/29。
这轮仍包含原会员取衣测试，说明先前失败具有间歇性；`214f0433` 的新增准备阶段断言另以其运行验证。

目标 Windows 的 `27b37191` Runtime 正式构建、smoke 与入口检查已通过，manifest SHA-256 为
`37cf7ce0bcc1924468399beaa939b5a72544bbe6a7dc123545719bb99c939913`。
随后 Counter 构建被 `WINDOWS_HELPER_FILE_INVALID` 拒绝；实测 helper EXE 为常规文件且 `nlink=1`，
摘要旁文件却为 `nlink=6`。先前 Runtime deploy 产生硬链接，原构建器只原子替换 EXE、原位覆写摘要，无法消除共享 inode。

摘要改用同目录独占临时文件与 rename 发布，保留原有唯一文件及 SHA-256 安全检查。
真实文件系统回归验证：旧 EXE/摘要链接副本字节不变，新 EXE/摘要均为 `nlink=1`，新摘要匹配，并覆盖发布失败清理及非 Windows 跳过。
4 项新增回归、8 项原有用例通过，2 项 Windows 原生平台用例在 Mac 上跳过；类型、lint、格式通过。
以旧原位写入替换新发布逻辑的私有反证运行明确为 3 通过、1 失败，失败为 `nlink=6`。
最终候选需包含此构建器修复后重新打包；没有通过修改校验门禁或改写已验收包绕过失败。

实机安装尚未执行，原服务未停止、旧宏发程序未覆盖。隔离 NSIS 安装的恢复脚本先在自有测试文件和注册表键演练，
确认备份完整性、注册表值类型及 ACL 恢复，再进入目标候选安装。最新 CI 与实机结果继续在 PR #233 记录。

### Windows 路径夹具修正（2026-10-06 03:37，Asia/Taipei）

`a27640fa` 的目标 Windows Runtime 与 Counter 构建、来源及完整性检查已通过，产品源码树干净，
SPA 保持 `bf5e0810c4da07cd3a873d92ef74e7e62c285fa23aee5ef5efd14a457f027151`。
Windows 原生 platform-fs 10/10 通过；桌面测试原为 13/16，三项失败都来自测试使用 `includes("operations/")`，
在 Windows 反斜杠路径下未命中故障注入或删除目标，生产 journal 的 `path.join` 行为正常。

三处改为按父目录名识别 `operations`，删除前明确断言目标存在且删除成功，所有业务断言保留。
Windows Counter CI 的 generic profile 追加直接运行已编译的 30 项 helper、文件系统及桌面恢复/维护测试，不重复构建。
本地 28 通过、2 项 Windows 原生平台跳过，其中桌面 16/16；完整类型、lint、格式、3 项 foundation 检查及独立复审通过。
后续 Windows 复跑会分别记录测试提交与 `a27640fa` 产品包来源；本次只改测试、CI 和记录，不改包或生产逻辑。

`214f0433` Foundation 与 `a27640fa` 双 profile 安装 CI 已通过。
`a27640fa` 两项 CI 未取得 hosted runner，等待 15 分钟后 job cancelled、steps 为空；保留其基础设施失败记录，不能计为测试通过。
NSIS 安装保护在同用户管理员令牌下的合成演练已通过，包括精确注册表值/SDDL、坏备份拒绝覆盖、完整子进程等待；
原安装仍未改动，实际安装与随后 Limited 权限的业务/UI/备份演练结果继续单独记录。
