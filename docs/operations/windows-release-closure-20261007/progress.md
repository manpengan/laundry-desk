# 进度

> 2026-10-10 补交的历史记录：下文的候选、分支、CI、进行中状态及清单截止于 2026-10-08 09:50（台北）。后续 `5db094aa` / `5587b003` 的失败、分项通过及恢复见[Windows 10 续验](../pilot-readiness-20261008/windows-acceptance.md)；本次 GitHub 输入 `c815bc7f` 与分支处置依据见[工作区核对](../workspace-reconciliation-20261010.md)。本轮整理没有复跑 Windows 测试或升级常驻服务。

历史记录更新时间：2026-10-08 09:41（台北）。

## 2026-10-07 入场

- 用户明确授权完成剩余工作、提交推送及合并所有 PR。
- GitHub main 已从上次状态 `560cb37c` 更新到 `4ba4db4d`，新增 PR #236 六套配色与分级动效。
- `gh pr list --state open` 返回空列表；不需要处理遗留开放 PR。
- 既有隔离 worktree tracked clean，fetch 后从 origin/main 建立本轮分支；原目录四个修改文件及生成物未动。
- Windows agent 正核对当前安装、8787 进程归属与交互会话；CI agent 正核对最新 main 门禁与可复用发行产物；explorer 正查安全升级与验收工具。

## 跨 schema 升级默认备份修复

- `UPGRADE_REQUIRED` 是对不同迁移的发行执行 install/repair 导致的预期拒绝；必须使用可信入口的 upgrade 动作，不能直接改状态。
- 发现实际缺陷：跨 schema 升级和已提交升级的维护恢复提前返回，跳过 ADR-91 的默认备份初始化。只对完成后运行中的成功升级补初始化，保留显式关闭、停止状态及回滚行为。
- 新增回归在旧实现上 3 项失败；修复后定向 31/31 通过。Runtime 全套本地 200 项：172 通过、28 平台/环境条件跳过；定向 lint/格式通过，独立 TypeScript 审查无 P1/P2 阻断。
- 原生无源码测试增加“旧版从未配置备份”的条件及每日 03:00 断言；Windows CI 已通过，目标实机结果尚未取得。
- 真实 8787 服务来自旧开发目录（HEAD `d3d04598`，134 项 tracked 改动）；原目录不改。已有默认 Companion 与当前服务不能混称同一安装。
- 既有向日葵服务的单次启动失败记录保留。随后在 Session 1 启动了已安装且签名有效的 AweSun，设备已在线；当前等待用户在既有窗口完成 Windows 登录校验，无需再修复服务，未改认证或服务配置。

## 候选、验收入口与 PR

- 产品候选 `9b242a8a7c92d33ededc0c6f08159a4f400715ba` 已提交推送。Windows 在独立干净目录构建 Runtime `0.1.11-win-dev.20261007`；18:33 的首次依赖安装失败、20:00 开始的第二次构建在部署子步骤超时，失败记录均保留。20:18 开始的第三次构建已完成 Runtime 与通用柜台打包；外部绑定检查器随后暴露依赖层级与 Windows 路径问题，修正经独立审查，复用来源未变的产物完成核验及宏发构建。双 profile 构建、隔离安装已通过，完整实机业务验收正在进行。
- 已下载并校验 Runtime 构建记录，产物来源为 `9b242a8a`、保证等级为 `development_only`，payload manifest SHA-256 为 `07e109d7f1ee95b41ddf0e8f9017735088baab34a49573604406b96be8d60ae2`；此记录不证明安装完成或运行服务已切换。
- `386cef549e45238f5bdf5ec6da9e0c68e894e079` 仅修改功能验收：强制预期产品 SHA/profile，校验实际安装的 EXE、ASAR、SPA、helper 和来源记录，独立记录测试 runner 与编译后检查器摘要，拒绝运行中变更和旧结果覆盖。
- 完整旅程、诊断及清理均成功后才发布最终通过记录；独立安全审查发现的提前发布问题已修复。13/13 证据回归、edge-agent 类型检查及定向 lint/格式/语法检查通过。
- `2da506b48be074264c885abfeb01e8035d180381` 仅更新旧验收清单；双 profile 功能 runner 固定使用该提交，与产品来源分别记录。
- `2911c6b69f8b3f86b90b8a0470591ffbb9b48ee4` 将 13 项安装来源/证据回归加入 Windows Counter generic 原生步骤，并更新进度文档。Foundation 的 `scripts/*.test.mjs` 已包含该测试；此提交不改变产品或功能 runner。上述四项提交均已推送。
- [PR #237](https://github.com/manpengan/laundry-desk/pull/237) 在 HEAD `2911c6b6` 的全部 6 项检查通过后，于 20:01:43（台北）普通合并为 main `1462e242bf580928dbfdef155bc95cd29e2959c8`；合并后查询开放 PR 为 0。旧 `2da506b4` 的 [Foundation](https://github.com/manpengan/laundry-desk/actions/runs/37608740068)、[PostgreSQL](https://github.com/manpengan/laundry-desk/actions/runs/37608740018)、[Counter](https://github.com/manpengan/laundry-desk/actions/runs/37608740089)、[Runtime](https://github.com/manpengan/laundry-desk/actions/runs/37608740158) 已因新 HEAD 替代而取消，不记作测试失败或通过。

## PR #237 与 main 的 CI

| 门禁                                                                                  | `2911c6b6` 的结果 | 已取得证据                                                                                                  |
| ------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------- |
| [Foundation](https://github.com/manpengan/laundry-desk/actions/runs/37609199754)      | 通过              | `workspace-check`、`runtime-app-macos` 均成功                                                               |
| [真实 PostgreSQL](https://github.com/manpengan/laundry-desk/actions/runs/37609199787) | 通过              | 服务端 1306 通过、0 失败、1 项 Windows 原生 DPAPI 平台跳过；data-maintenance 4/4 通过                       |
| [Windows Counter](https://github.com/manpengan/laundry-desk/actions/runs/37609199829) | 双 profile 通过   | generic 原生 49/49，包含新增 13 项证据回归；generic/hongfa 各自安装 smoke 1/1、安装后登录及合成订单重启 1/1 |
| [Windows Runtime](https://github.com/manpengan/laundry-desk/actions/runs/37609199806) | 通过              | 无源码目录与系统 Node 的原生生命周期 25/25 场景通过，包含备份恢复、跨结构升级与成对回退                     |

PR 共 6/6 检查成功；CI 的临时 Windows 环境与目标实机验收分别记录。合并后的 main `1462e242` 另行启动的 [Foundation](https://github.com/manpengan/laundry-desk/actions/runs/37618108462)、[PostgreSQL](https://github.com/manpengan/laundry-desk/actions/runs/37618108294)、[Counter](https://github.com/manpengan/laundry-desk/actions/runs/37618108168) 已成功；[Runtime](https://github.com/manpengan/laundry-desk/actions/runs/37618108479) 于 22:01:09 完成成功，已下载日志复核原生生命周期 25 项通过。

## 实机发现的旧版回退兼容修复

- `run-2378c185` 的真实回退失败后，核对 f777 旧 payload 的 manifest 和配置模块摘要，确认旧目标不接受新版传入的 Windows 照片目录；同一问题同时影响影子健康探测和回退后的正式启动。原始底层异常已被探针捕获丢弃，未声称从日志还原 throw 堆栈，也未将约一分钟的整个动作耗时当作探针超时。
- 按已经验证的目标 manifest 的既有照片能力统一构造环境：旧目标彻底省略照片目录变量，新目标保持受控目录；影子探测仍隔离 LOCALAPPDATA、还原并校验照片字节、真正创建 Runtime 并检查健康。没有固定 SHA 特判、没有改变旧发行文件或放宽探针成功条件。
- 新增 7 项回归通过，隔离恢复旧行为后有预期 3 项失败；全 Runtime 207 项为 179 通过、28 平台条件跳过、0 失败。独立复审 30/30、定向 ESLint/格式/diff 通过。
- 新产品候选 `107c592287d1f3a3c14ad8527e7a505e5930a9d8` 已提交推送，[PR #238](https://github.com/manpengan/laundry-desk/pull/238) 已创建，六项检查运行中：[Foundation](https://github.com/manpengan/laundry-desk/actions/runs/37627523321)、[真实 PostgreSQL](https://github.com/manpengan/laundry-desk/actions/runs/37627523161)、[Windows Counter](https://github.com/manpengan/laundry-desk/actions/runs/37627523245)、[Windows Runtime](https://github.com/manpengan/laundry-desk/actions/runs/37627523202)。新候选将在独立 `ld-release-20261007-next` 目录构建，旧 `9b242a8a` 的产物和失败记录保留。
- `run-c2425755` 另用 `9b242a8a` 新建独立合成实例，只验证当前版备份和后续业务/UI，不包含跨结构升级或成对回退。21:16:03 的核心备份恢复里程碑通过：备份与校验后实际修改订单、删除照片数据库行和文件，再恢复原订单、元数据和字节并完成影子演练。该轮首个 generic 功能旅程在启动前因验收脚本的 SPA 布局误判失败，未开始业务 UI；21:21:29 独立只读核验确认原服务、3 项任务、双原安装精确恢复且无测试残留。备份恢复通过不关闭原回退缺陷或代表新 `107c5922` 已实机验收。

## Windows 实机与剩余资源

- 离线依赖安装缺少两项缓存；联网下载后 921 项已导入，但随后的完整锁文件验证出现大量请求超时。诊断同时定位到 pnpm/Node 超时处理对只读 `message` 的赋值异常。换用已校验的 Node 22.23.2 并保留既有缓存后，1080 项锁文件验证完成、966 个请求零失败；随后移除会被 Worker 继承的诊断观察器，19:50:22–19:50:39 正常安装 exit 0（17.23 秒）。Node、缓存与诊断存在混杂因素，不认定唯一根因；没有跳过完整性或供应链检查，也未修改项目并发配置。
- Runtime 升级、默认备份、数据库及照片恢复、双 profile 安装/功能、强杀恢复和维护 GUI 的执行脚本已完成对应审查。预执行审查修正了账号文件目录、缺服务测试与 Runtime 端口冲突、任务硬超时和 Playwright Windows 启动外壳 PID；强杀脚本读取真实 Electron 主进程 PID 后继续严格核对归属，并以直接 psql 比对提交前/恢复后/主动下一单后的订单与支付全集合，不能以 API 查询代替；自动化 GUI 结果也不能替代普通店长真人验收。
- 20:37:49 同源 Runtime、generic/hongfa 正式构建和实包绑定完成；公开 7 份构建记录已下载逐摘要复核。原生回归共 36 项独立用例通过（helper 4、文件系统 10、桌面恢复/维护 22），重复运行的 helper 不重复计数。20:42:42 独立 runner 准备完成。20:49–20:51 双 NSIS 隔离安装通过，原入口在精确 DACL 修正后各 7/7 恢复，早期失败记录保留；详见 [候选验收](acceptance.md)。
- `run-2378c185` 于 20:52:12 开始实际 QA，受控停止原开发服务、保存任务及状态，在独立合成根执行。双 profile 缺服务 package 测试均通过；20:57:52 的跨 schema 升级里程碑通过，0069→0082 默认 03:00 备份生效、1 订单及 1 照片保留。随后 rollback 在程序探针失败，终止码为 `WINDOWS_COMPANION_PROGRAM_PROBE_FAILED`；后续业务/UI 未执行。原报告误捕获计时前缀的字段保留，准确错误单独记录，根因正在定位。
- 本轮 finally 20:59:20 完成，21:00:37 独立只读恢复证明通过：原服务 ready 且入口/Node/launcher 摘要相同，3 项任务的 XML/SDDL/enabled 与原值一致，双原安装的程序/注册表/快捷方式/缓存一致，QA 进程、UI 任务和任务引用均为 0。准备以新的当前版合成实例独立执行备份恢复和业务/UI，保留原回退失败未关闭，不将分项通过汇总成完整通过。
- Windows 11 历史宿主的 Tailscale 连接在 18:40 复核仍使用 IPv4 直连，未满足 Linux SSH 技能的 IPv6 条件；未打开 SSH。已请求本轮路径例外但尚未获答复，Win11 当前资源与验收均未确认。
- 跨 SID 恢复仍在执行方案核对阶段；目标 sshd 允许本地账号密码且未限制 AllowUsers/AllowGroups，因此本轮未创建会新增远程入口的临时账号、未执行跨 SID 迁移；后续须在明确的账号隔离方案或独立测试机执行，同机跨 SID 也不能替代跨机证据。长期备份、正式签名/分发裁决、外部渠道和设备、真人与辅助技术验收、ADR-98 签署继续保持未完成。

## 安装来源验收的 SPA 布局修复

`run-c2425755` 的第一条真实错误为 `WINDOWS_FUNCTIONAL_EVIDENCE_SPA_TREE_INVALID`。实包的 manifest 位于 `resources/spa/manifest.json`，活动 bundle 内恰好 45 个声明资源，没有第二份 manifest，也无额外文件或重解析点；旧证据 helper 错误要求 bundle 内重复 manifest。已修复测试代码，并改用生产 `syncSpa` 创建回归夹具；相关 46/46、独立 16/16、类型与 lint 通过。测试专用提交 `939db9bc7e45d6222f8defaac996ea4a0bac8304` 已推送至 PR #238；产品仍固定 `107c5922`，新 runner 单独固定 `939db9bc`，保留旧失败日志及原证据，不降低路径、来源或内容摘要校验。

PR #238 的最新 HEAD `939db9bc` 对应 [Foundation](https://github.com/manpengan/laundry-desk/actions/runs/37628939112)、[PostgreSQL](https://github.com/manpengan/laundry-desk/actions/runs/37628939097)、[Counter](https://github.com/manpengan/laundry-desk/actions/runs/37628939104)、[Runtime](https://github.com/manpengan/laundry-desk/actions/runs/37628939110) 六项检查正在运行；旧 HEAD `107c5922` 的运行被新提交替代，不能记作最新通过。

21:32 再次执行 Linux SSH 技能的只读连接预检，Tailscale 从 DERP 切到 IPv4 直连，仍未满足技能要求的 IPv6 直连；未打开 Linux SSH，Win11 宿主未操作。未收到路径例外答复，不沿用旧 Win11 证据。

## 新候选正式构建

`107c5922` 于 21:24:24–21:31:42 在独立 `ld-release-20261007-next` 干净目录正式构建成功。Runtime `0.1.12-win-dev.20261007` manifest 为 `2b7b42d2b16e2a0a635295c072040c5fef065257089b87e856348b6aa098dbab`，双 profile SPA 仍为 `ef00ad83…`，两个 ASAR 实际绑定同一 Runtime manifest 和入口。7 份公开构建记录的尺寸、SHA 与来源已下载复核；安装与真实升级/回退、业务 UI 独立接续，当前原服务尚未切换。

PR #238 的新 HEAD `939db9bc` 已取得 workspace、PostgreSQL、双 profile Counter 和 macOS Runtime 通过，共五项；Windows Runtime 尚在执行。Counter 日志已下载复核，generic 原生 52/52（含 16 项修复后的证据回归），generic/hongfa 各自安装 smoke 1/1、合成订单及重启 1/1。CI 安装器自报来源为 GitHub 合成合并态 `473d11ed`，与目标实机产品 `107c5922` 分别记录。

新候选双 NSIS 隔离安装、各 7 项原入口精确恢复与 runner 对真实双安装树的预检均已通过。完整 `run-18c93fdb` 于 21:43:23 启动，在 Session 1 普通令牌执行双柜台 UI。21:56:58 的 Runtime 终态已下载，六份回执的尺寸与摘要逐项复核：旧版基线、跨 schema 升级默认备份、成对回退、保留数据重装、数据库及照片真实恢复和影子演练五项均通过；21:59:17 的维护入口同源绑定通过。

通用版功能旅程于 22:03:09 报告通过，正在收集最终原始证据，宏发及后续 D04/维护/视觉/原生关闭继续执行。已实际查看通用版工作台、退款详情和重启后三张合成截图，未见遮挡或横向溢出；部分截图仍处于异步刷新/加载瞬间，不作为加载完成状态证明。

## 双版本业务终态与 D04 测试脚本诊断

`run-18c93fdb` 的双 profile 基础业务旅程已取得真实终态：generic 22:03:09、hongfa 22:05:33 成功；source `107c5922`、runner `939db9bc`、EXE/ASAR/SPA/helper 摘要匹配，实际 1707×1004 CSS 像素、150% 缩放、10 个导航页面、renderer errors/server failures 均为 0。14 份最终公开 JSON 的尺寸和摘要已重新核对。

随后 hongfa D04 在 `kill-owned-process-tree` 阶段返回 `D04_PRIVACY_INVALID`。这是 helper catch 的默认码，原始异常类别与位置未保存，无法事后判断是否执行强杀，更不能当作跨重启恢复通过。维护、视觉和原生关闭尚未执行。22:06:46 的 finally 无错误；22:14:02 独立只读核验确认原服务 ready、原入口/Node/launcher、三任务 XML/SDDL/enabled、两个原安装全部一致，测试进程和任务残留为 0。

静态审查发现 helper 尚未验证目标进程 owner SID/SessionId，并需改进安全异常分类；原 PID、创建时间、路径、argv 和 userData 校验保留。PowerShell 5.1 的原生 stderr 重定向可能在退出码检查前抛异常，当前只是候选机制。以专属普通令牌 Node 测试树采集诊断后，再对最窄修正进行复验，不跳过非零退出或隐私检查。

本轮基础 functional 不是全部 D/U 专项：按件照片上传、短窄窗口矩阵和真实 IME 输入未包含在该旅程中；后续 D04/维护/视觉/原生关闭编排只针对 hongfa。完整覆盖范围以实际执行的断言和终态为准。

22:25–22:26，在 Win10 Session 1 普通令牌的独立 Node 父子测试树复现 PowerShell 5.1 stderr 机制：`Stop` 下 stderr+exit0 仍抛 `NativeCommandError`；局部 `Continue` 后可读 exit0，stderr+exit7 保留失败。错误创建时间、exe、userData 均被拒绝且进程仍存活。最终 helper `34a1d9fb…bf9b0f9` 增加 owner SID 与 Session 双次检查，保留原 30 项 Require 及严格退出码；正确测试树在 4077ms 时父子均消失，早于 45 秒自退。两份原始 JSON 摘要已复核；这些证据不倒推旧 Electron 异常的唯一根因。

新 `run-7d07cb87` 使用同产品/runner 的独立当前版续验模式，明确不重复跨 schema 升级与成对回退（对应 `run-18c93fdb` 已过），继续实际备份恢复、双功能和 hongfa 专项。9 份脚本与基线摘要已复核，原环境 snapshot/finally 保持原样，不覆盖旧脚本或旧证据。

## 当前版续验的主题切换失败

`run-7d07cb87` 的当前版 Runtime 备份恢复于 22:36:45 再次通过；22:40:21 的 generic 功能旅程在 `windows-functional.spec.ts:508` 失败：选择“海盐”并断言成功后点击“晴空”，5 秒内 HTML `data-palette` 仍为 `sea`。随后 DOM 诊断也在 2 秒内超时，现有记录不足以区分输入丢失、View Transition 回调调度或 renderer/CDP 卡住。没有失败时截图，不能从旧截图推断根因；未修改产品或放宽断言。hongfa 功能、D04、维护、视觉及原生关闭均未进入。

22:40:56 finally 无恢复错误，22:43:58 独立只读核验通过：原服务 PID 20540 ready，原入口/Node/launcher、三任务及双原安装一致，测试进程和任务残留为 0。7 份最终公开 JSON 的尺寸及 SHA-256 已逐项核验。准备复用同一隔离 QA 数据库和已创建 generic 合成账户，以新 userData、新诊断 ID 和白名单事件时间线定位主题问题；不覆盖既有失败结果，也不重新创建账号。

23:06:27，同包主题诊断 `theme-8dd10c28` 启动：复用 `run-7d07cb87` 已停机的合成 Runtime 与 generic 账户，产品及 runner 不变，独立 userData 和证据子目录。7 份新脚本与链式摘要已复核，Windows PS5 解析、Node 语法检查及 fresh before 通过；观测脚本 SHA-256 `f86f9bb4291ae73ddd5abe8b079bca07e7476272a74609a7f30a8576cc1b7f0e`。20 轮主题/明暗切换保留原 5 秒断言，首错即停，只记录白名单状态。VT Promise 观察与日志 fsync 会改变负载，本诊断不能替代原 functional 通过。

本次再次只读查看向日葵，DESKTOP-MAN 仍停留在空白 Windows 账户/密码校验界面，没有可操作的远程桌面；未输入凭据或更改认证。

`theme-8dd10c28` 同源 Runtime 启动与身份核验通过，但探针在进入第 1 轮前的设置导航/前置检查阶段失败，不能称为复现原海盐→晴空问题。白名单时间线显示 renderer 心跳仍约每 500ms 产生、测试 Node 心跳每秒正常，但一批页面消息延迟约 9 秒抵达测试进程；visible/focused 一直保持到正常关闭前。当前只能确认消息交付存在延迟，不能认定 renderer JS 冻结或主题代码根因。准备增加固定步骤及两条本机调试通道的有界计时诊断，保留原断言超时。

23:08:19 finally 无错误，23:10:26 独立 after 确认原 PID 27392 ready、三任务及双原安装精确一致，测试进程/任务/引用为 0。9 份公开回执与事件日志的尺寸和摘要已复核。首次回传 TCP 连接超时后恢复，只读核验没有重新启动测试。

23:20:29，第二轮定位 `theme-b3e8126a` 启动；新脚本 `db943ed2…4ef2a50` 仅增加固定步骤日志和 Electron 主进程独立 stdout 数值心跳。所有原点击/断言时限不变；心跳 500ms、60 秒自停、最多 120 条，单次安装 Promise 未真实结束前不重试。4 份新增脚本尺寸/摘要、Windows 解析与 fresh before 已核对，旧脚本及失败记录保留。本轮仍属于诊断，不代替正式功能验收。

## PR #238 合并与设置加载优化

[PR #238](https://github.com/manpengan/laundry-desk/pull/238) 的 HEAD `939db9bc` 六项检查全部通过；Windows Runtime 于 23:27:30 完成，下载日志已逐场景核对 25/25 通过。23:30:52 使用精确 HEAD 普通合并为 main `1c16fc15f94b46168f8a76793c97e64616079891`，没有删除分支，随后开放 PR 为 0。main 新提交的合并后 CI 与 PR 的通过分别记录。

第二轮主题诊断 `theme-b3e8126a` 确认：SETTINGS 点击耗时 3974ms，SECTION 操作于 10016ms 超时，尚未执行 DEFAULT 或主题切换。Electron 主进程自主心跳 seq7→8 的真实生成间隔为 6586.7674ms，stdout 接收与生成时间几乎相同，renderer 仍约每 500ms 心跳；这次不能仅解释为调试消息延迟。23:22:17 finally 无错误，23:22:54 独立 after 确认原 PID 15468 ready、原任务和双安装精确一致、测试残留 0。

源码调查发现设置页首次挂载所有隐藏分区：桌面 admin 共触发 14 次读取（7 次业务查询、7 次其他端口调用；会员开启再增加 2 次）。业务查询会触发离线缓存维护，其中有同步文件、ACL 与本机 helper 操作；静态调用次数不是实測耗时。新分支 `codex/windows-settings-loading-20261007` 从已合并 main 接续，先修正未访问分区的多余挂载，保留访问后的编辑状态和所有缓存安全校验。新候选尚未提交、构建或验收，不把旧 107c 安装包计为已包含该优化。

### 设置按需加载实现与本地验证

- 生产仅修改 SettingsLayout：首挂前校验偏好，按需首次挂载；已访问分区保留草稿，身份/门店/权限范围变化重新挂载。
- 新增负对照 8 项在旧实现失败；针对性 23/23、独立审查通过。全量首次运行 677/679，两项 shell SSR 仍假定未访问面板首挂；指定实际分区后保留功能、端口和角色门禁覆盖。
- 最终全量 Web 679/679、零跳过；Web typecheck、5 个源码/测试文件 ESLint 与 Prettier、git diff 检查通过。日志 `/private/tmp/ld-settings-loading-full-web-final.log`，新候选尚待提交与 Windows 实包复验。
- 独立 Windows 新目录 `C:/dev/ld-release-20261007-settings` 从已合并 main1c16 clean 准备；Node/锁文件/runner939 摘要核对通过。15:46:28–15:46:41 UTC 在 Session1 普通令牌完成冻结离线依赖准备，未构建产品、未动原服务和安装。

### 新候选构建前的会话守卫与 SPA 同步

- 设置按需加载已以 `285760b7ef84cbe88efdb8873707601f24fc4052` 提交推送至 PR #239。双 Counter CI 在 `SPA_SYNC_OK` 后的 helper staging 失败；内置 SPA manifest 仍指向旧编译产物，当前 UI 编译后会改变受追踪 manifest 并新增 bundle，触发源码干净门禁。修复采用同步本轮精确产物，保留历史 bundle 与完整性检查。
- 后续安全审查复现 query 在维护等待后重读全局会话的逻辑缺口。合成授权/runtime 边界配合真实加密缓存可产生身份错配；慢授权对照未产生污染，完整 Runtime/HTTP 可达性尚未证实。仅处理自有项目的合成回归，没有真实数据泄露证据。
- 最小修复固定发起 query 的 session/revision，在每个异步返回点检查；只读会话正常恢复在线保留原 reconcile 副作用而不制造新身份代际。新增 22 项负对照在旧实现为 20 失败/2 通过，首轮修复后 query/既有 service/实际 cache 42/42 通过。
- 同类 command health 等待和 queue 内部 schema 等待边界纳入守卫，独立 TypeScript 审查继续；Windows 最终构建等待统一新 SHA，285 包未构建或部署。
- Computer Use 再次只读查看向日葵，仍处于 DESKTOP-MAN 的 Windows 账号/密码校验页，未获得可操作桌面。

### 最终产品固定与新一轮门禁

最终产品 `fecb90c4c27207af8344edd34dec277fcdcf9383` 已提交推送至 [PR #239](https://github.com/manpengan/laundry-desk/pull/239)。包含设置提交 `285760b7`、精确 SPA 同步 `c7f020ae` 与最终 query/command 会话守卫；SPA bundle 为 `40d88eb8353d8c23cc66ab04acb60a838172b8d7f908eb2ad2d87ff0a6fbf63d`。新增 helper 已补齐双打包白名单，完整 edge 命令 703 项：701 通过、2 项 Windows 原生条件在本机跳过；offline/HTTP 126/126，独立安全与 TypeScript 复审通过。

31 份 Windows 构建、安装、续验及 runner 复用脚本的文件摘要已逐项核对，与已审查模板相比仅固定 source、联动摘要及任务名称。新产品从 main `1c16fc15` 的独立 clean 目录接续，Runtime 版本 `0.1.13-win-dev.20261007`；功能 runner 仍固定 `939db9bc`，不把复用记录写成重新编译。

新 HEAD 的 [Foundation](https://github.com/manpengan/laundry-desk/actions/runs/37650021190)、[PostgreSQL](https://github.com/manpengan/laundry-desk/actions/runs/37650021085)、[Counter](https://github.com/manpengan/laundry-desk/actions/runs/37650021173) 正在执行。main `1c16fc15` 的独立 PostgreSQL 检查在取消订单测试的价目准备阶段超时，29 项中 28 通过；服务读取均成功，缺少失败页面证据，尚不能判定根因。正在用新源码定向复现，不用旧 PR 绿灯替代 main 结果。

### Windows 系统重启中断与补验清单

最终产品首轮构建于 16:20:24 UTC 启动，目标电脑随后发生系统重启：1074 事件为 16:21:01，6006 为 16:21:33，系统新启动时间为 16:21:54。构建任务返回 `0x40010004`，缺少 build.exit 和最终回执；日志只到 BUILD_SERVER，没有可归因的编译错误。因此记为环境中断，既不通过也不归因产品失败。原服务在重启后 ready，但这不是新候选的重启验收。

7 份中断证据于 16:34:26 UTC 原位归档到独立 interrupted 目录，逐文件 SHA 前后相同；没有删除旧任务、日志或其他工作区。build.ps1 保持原摘要，新 attempt2 只使用独立任务/runner 日志名称，于 16:34:46 单次请求构建。跨系统启动不沿用旧 PID 清理。原生 UI 还需目标桌面解锁；用户操作请求已提出，构建和其他验证继续。

剩余清单交叉核对新增以下专项，不能由既有相近场景替代：实际离线队列重启并恰好一次回放；未提交草稿直接强杀后字段恢复且订单/收款零增量；第二实例与回焦；空合成门店内真实 v1 导入、照片与一次性批准票据。旧 v1 活动源码和真实数据保持冻结。pre-submit 窄脚本已完成独立静态审查，其他补验在准备，均尚未记为实测通过。

取消订单 E2E 定向复现确认固定价目新建请求可被拒绝而测试读取旧行误通过；补缴输入与默认值初始化也发生竞态。测试修正使用独立价目、按唯一名称搜索、真实 POST 响应断言与白名单诊断。目标 5 项连跑三轮通过。完整旧库一轮为 23/29，另外 5 项在超过 50 条价目时未搜索直接选择失败，1 项已有会员积分策略拒绝；继续定位测试隔离，不清库或把全套记为绿。

### 测试修正终态与新候选安装

测试提交 `7248c79fa59d018628a2a0b679f4195dde62c0f5` 已推送到 PR #239。六个旅程共用按唯一名称搜索的价目选择，取消订单使用独立价目并断言真实写入响应；补缴先等待默认金额再填写并断言实际请求。已有积分策略通过 UI 核对目标规则，非等价规则保持失败；计价保存等实际配置加载完成后读取版本。最终完整浏览器旅程 29/29、43.4 秒，保留数据库已有 74 条以上价目，没有清库。该本地服务镜像为旧构建，不能替代当前源码的 PostgreSQL CI。新增 CI 仅收固定白名单诊断，公共产物不上传原始 trace；独立复核、类型/lint/格式通过。原 main 取消订单超时的唯一根因仍未证实。

产品 `fecb90c4` 的五项 CI 均已成功；新增测试 HEAD `7248c79f` 重新启动 Foundation、PostgreSQL、Counter，必须以新 HEAD 的终态作为合并依据。main `1c16fc15` 的 Windows Runtime 检查仍运行，不能以旧 PR 的通过替代。

Windows attempt2 于 16:41:15 UTC 完成，Runtime 与双 Counter 同源构建成功；7 份原始回执逐尺寸/摘要/来源复核。实际 ASAR 中新 query helper 及 runtime/service 与编译输出一致。原生回归 36 项独立用例通过、零跳过，重复 helper 4 项单列。双 NSIS 于 16:52:31 / 16:53:47 完成，各 7 项原入口精确恢复；原始恢复标志失败和修正成功回执均保留。16:56:22 双安装树 45 资源预检通过。

`run-abe8254f` 于 16:57:27 UTC 启动最终产品的新实例实机回归。补验脚本分别覆盖提交前草稿强杀、真实离线队列重启、设置原生端口/第二实例，以及全新空合成库的 v1 UI 导入和独立重放。补验尚未取得实机终态，不记为通过。

### PR #239 合并与取衣重载诊断

HEAD `7248c79f` 五项 CI 全部通过，原始日志已下载复核：真实 PostgreSQL 服务测试 1306 通过、1 项平台跳过；维护 4/4，浏览器旅程 29/29，空卷 commissioning 1/1。双 Counter CI 的合成合并来源为 `b58c6e79`，generic 原生 52/52、两 profile 各缺服务与订单重启 1/1；不将其作为目标机器 `fecb90c4` 的安装证据。

2026-10-07 17:16:49 UTC，PR #239 以精确 HEAD 普通合并为 main `1055ed0ea406967453e1740a4950866fde7e1bed`，没有删除分支或绕过门禁；远端 SHA 与 PR mergeCommit 一致，当时开放 PR 为 0。合并后四组 CI 分别是 Foundation `37657839946`、PostgreSQL `37657839926`、Counter `37657839994`、Runtime `37657840000`，正在执行。隔离 worktree 从此 main 接续 `codex/windows-pickup-latency-20261008`，保留文档修改，产品 `fecb90c4` 未变。

`run-abe8254f` 的当前 Runtime 终态于 17:02:31 UTC 通过：0082/default 03:00 备份、真实修改订单并删除照片数据库行和文件后恢复、校验与影子演练。四份 Runtime 公开原始 JSON 的尺寸及 SHA 已核对。本轮明确不含跨 schema 升级、成对回退及保留数据重装，其最后一份完整证明仍绑定历史 `107c5922`。

generic functional 已通过原设置/配色段、客户、开单与退款，17:08:32 在取衣显式重新加载后的 `expect(reloadOrder).toBeEnabled()` 失败，默认 5 秒时按“加载订单”名称找不到按钮。私有失败页面仍为取衣，按钮实际显示“加载中…”且禁用，并非证明永久改名。源码显示第一次 UUID 加载只调用 order.get；显式票号重载依次调用 order.lookup、order.get，成功后还等待本地维护及加密缓存。准备分离 HTTP、bridge 与主进程停顿测量，不直接延长超时或将其归为纯测试问题。

本轮后续 hongfa/addon/D04/维护/视觉/原生关闭均未执行。17:09:00 finally 无恢复错误，17:10:39 独立 after 核对原服务 PID 12068 ready、原任务/双安装精确一致，测试进程/任务/引用为 0；7 份 final JSON 已逐尺寸/摘要复核。已实际目视新 generic 设置截图，卡片/导航无遮挡；中间滚动与 toast 状态不充当最终视觉矩阵。Computer Use 只读查看向日葵仍停留 Windows 账号/密码验证页，没有已认证远程桌面。

### 真实链路诊断与补验准备

2026-10-07 17:28:50 UTC，旧 main `1c16fc15` 的 Windows Runtime 检查 `37644531595` 成功；原始日志逐场景核对 25/25，完整作业耗时 117 分 52 秒。长时间运行不等于挂起。新 main `1055ed0e` 的 Foundation 与 Counter 已成功，PostgreSQL 与 Runtime 仍运行，两个版本分别记录。

runner `7248c79f` 首次准备因缺少 server/dist 三项依赖而未通过完整 E2E 类型检查。保留原失败及日志摘要，只补 domain/migrate/server 编译后，17:29:41 UTC 完整类型检查和锁定 CLI 检查通过；source clean，旧 runner939 与产品源码未改，没有重复安装依赖或操作服务。两份原始 JSON 已回读。

Pickup 首版仪器误选 undici 通道，经独立审查确认当前 Electron 请求实际使用 net.request，未部署该版。修订脚本 `d95b503e` 被动计时真实 net.request 与精确路径 helper，保留原参数、返回值、异常及事件监听；必须取得 reload 两次 query 和直接 bridge 两次 query 的完整 HTTP 样本，reload helper 也必须非空。七文件联动摘要 `7a617d66` 已逐项复核，原 finally 仅基目录机械替换。新诊断 `pickup-c6ef704d` 于 17:50:53 UTC 实际启动，锁屏情况如实记录；只读合成旧失败订单，不作为完整 functional 通过。

备份 GUI 损坏负例与 D05/D06 业务补验正在准备。备份探针只改当轮新建备份 dump 的末字节，必须实际 GUI 与 CLI 拒绝后恢复原字节；原健康备份和运行数据库不改。已补齐维护进程真正退出及全部清理后的 attention 检查，实际抽取字节逻辑 8 项本地测试通过，独立审查通过；尚无 Windows 执行结果。

### Pickup 实测与缓存持久化热点

首轮 `pickup-c6ef704d` 在主进程仪器初始化失败，未执行业务查询，0 条完整测量；17:52:21 finally 与 17:53:22 独立 after 均确认恢复，残留 0。第二轮 `pickup-4b7e216c` 用 Node 内建模块同步加载器，实际 Electron 上捕获旧动态导入固定错误码 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`，未输出原始异常。首轮没有采集该码，不能倒推首轮唯一原因。

第二轮于 18:00:52 UTC 取得完整实测，13 份原始 JSON/JSONL 已逐文件大小和 SHA-256 核验：实际 UI 重新加载 2574.4604ms，本轮原 5 秒断言通过；两个 HTTP 请求分别 9.7399/8.9817ms，reload 阶段 40 次受信同步 helper 合计 2375.9674ms。独立 bridge lookup/get 为 1066.3/940.7ms，各 16 次 helper 分别占 1008.439/892.1399ms，对应 HTTP 均小于 8ms。主样本摘要 `d16b118e`。这是同步安全文件持久化的明确热点，不证明原完整旅程超过 5 秒的唯一原因，也不替代 functional。

18:01:19 finally 无错误，18:02:49 独立 after 确认原 PID 2840、双安装与任务精确恢复，测试残留 0。探针 userData 的缓存文件只读元数据显示 7606 字节；原失败旅程没有可信 userData 绑定，其缓存规模保持 unknown，没有扫描 Temp 猜测目录或读取缓存正文。

基于实测，在线 query 在现有维护队列内合并绑定与投影保存，减少同一授权与结果的重复安全文件读写。ACL、加密、原子替换、离线读/恢复和其他业务维护流程继续保留；异步解析完成后及写入前重验发起会话。新增测试覆盖一次持久化、不同实例交错写入、授权续签、旧身份/时钟回拨、密文与链接变更、登出及持久化失败。独立审查要求保留换身份时的未来检查点，已补验证；另发现 128 条容量逐出遗漏，已修复并补充第 129 条缓存续签与逐出回归。

## 2026-10-08 02:32（台北）：查询缓存修复提交与新候选

产品 `a2ab1d9c7b22203eb527f2a93b9127b5834bfbfe` 已提交推送到 [PR #240](https://github.com/manpengan/laundry-desk/pull/240)。16 项新增测试已纳入离线/HTTP 定向 130/130；完整 Edge 脚本 168/168、单元 549 通过及 2 项平台跳过，共 717 通过/2 跳过。最终类型检查、ESLint 和两轮独立审查通过。此时新 PR 的五项 CI 正在运行，尚未合并。

新 Windows 根为 `C:\dev\ld-release-20261008-pickup`，Runtime 发行标识 `0.1.14-win-dev.20261008`。32 份脚本已固定最终来源及依赖摘要；root 和独立审查分别重算每份原始与最终摘要、确认机械替换后全文相等，唯一额外校验是把 `read-cache.js` 纳入两个实际 ASAR 的逐字节证明。新安装和各项业务尚未记为通过，旧候选及失败证据继续保留。

main `1055ed0e` 的 PostgreSQL CI 已成功，下载日志确认服务 1306 通过/1 平台跳过、维护 4/4、浏览器 29/29、空卷 commissioning 1/1；Foundation、Counter 同样已绿，Runtime 仍待终态。

## 2026-10-08 04:30（台北）：查询修复合并、实机 Runtime 与取衣状态修复

PR #240 HEAD `713efb69` 的五项检查通过后，于 2026-10-07 19:10:09 UTC 普通合并为 main `07164f832e62688d55e08044f5641fb646fd623f`。未删除分支、未绕过保护。该 main 的 Foundation、双 Counter 与 PostgreSQL 已成功；Runtime `37672432293` 于 21:07:45 UTC 成功，原始日志逐项核对 25 个独立场景全通过。较早 main `1055ed0e` 的 Runtime `37657840000` 已成功，原始日志确认 25 个独立场景全通过，两个版本分别记录。

产品 `a2ab1d9c` 的 Runtime `0.1.14` 和双 Counter 于 18:41:09 UTC 同源构建完成，原生 36 项独立回归通过；双 NSIS、7/7 原入口精确恢复及实际安装树绑定通过。`run-f5cea3c7` 的当前 Runtime 恢复与双 profile 基础业务通过，原 5 秒取衣重载断言通过，没有另测精确耗时。additional 在首窗等待前读取窗口几何而失败，原现场没有几何值，续验仅调整等待顺序并保留判据。finally 与独立 after 均通过。

`run-6559fd3a` 的提交前草稿强杀在读取 `$LASTEXITCODE` 时报错，不能证明实际强杀成功；离线阶段未运行。`run-b6c9271e` 的空 Runtime 安装被旧 helper 的严格 stderr 判据拒绝，迁移及第二实例未运行。源码确认直接生命周期程序会输出计时协议，后续仅识别固定格式的已知成功计时，非零退出和未知诊断继续失败。两轮原环境均精确恢复，安全失败回执已独立核对。

完整 Runtime `run-320a8f46` 于 19:52:59 UTC 五项里程碑全通过：真实旧版 0069 基线、升级 0082、程序与数据库成对回退、保留数据卸载重装、备份后真实删除照片元数据/文件并恢复及影子演练。19:55:31 finally、20:03:45 独立 after 通过，原服务/任务/双安装精确恢复、残留为零。5 份原始 JSON 尺寸和 SHA 已复核。

坏备份 `run-04f2a968` 的前置 Runtime 恢复通过，专项在 preflight 报 `MGUI_COMMAND_FAILED`，尚未执行业务负例。原 stderr 未记录，不能追认为计时输出冲突。20:14:38 finally、20:15:45 独立 after 通过，6 份原始 JSON 已独立核验。新 helper 保留所有命令成功及负例判据，只增加安全诊断和严格计时协议识别。

实际取衣结算截图发现上一单 16.00 元金额与确认按钮残留；下一单和部分取衣重载会继承该金额，DOM 回归还复现同刻点击发出两次命令。直接在已清空选衣的结单页重按会被旧校验拒绝，不声称已经发生重复收款。产品修复 `352f69f5` 将金额、选衣与活动订单共同失效，增加同步提交锁，处理到账/提交竞态，并在已确认成功但回执无法解析时清除草稿。

修复前 7 场景 6 项失败；修复及相邻行为三轮 36/36，新增回执异常后最终 DOM 11/11，Web 全量 679/679、完整类型/lint、SPA 45 项资源和独立审查通过。PR #241 已创建并推送。首轮 workspace 认证导入门禁发现测试夹具 `import(path)`，测试提交 `c5eeb80d` 改为真实 DOM 按钮卸载 React 页面，保留全部行为断言；本地 foundation 11/11 和 DOM 11/11 再次通过。此时新 HEAD 的 Foundation、双 Counter 已通过，PostgreSQL 仍运行。

Windows 新产品固定为 `352f69f5`、Runtime `0.1.15-win-dev.20261008`，20:23:51 UTC 在独立根 `C:\dev\ld-release-20261008-final-ui`、Session 1 普通令牌开始构建。源码准备原脚本尾部因旧 runner 的 PowerShell 模块缓存触发 clean 检查；只归档已知摘要、4641 字节的生成文件，另立 continuation 回执，不将原失败改记成功。尚未报告新包安装或 UI 通过。

### 05:20 接续：新包安装与脚本工作目录隔离

新产品 `352f69f5` 构建于 20:30:39 UTC 完成，双 NSIS 于 20:37:32 / 20:39:06 完成，原入口各 7/7 精确恢复，实际双 ASAR 绑定 manifest `95e8a4ec` 与入口 `af2f7574`。构建 7 份、安装 8 份及 runner/preflight 3 份原始 JSON 已逐尺寸/SHA 独立复核。PR #241 最终 HEAD `c5eeb80d` 五项 CI 全绿；真库服务 1306 通过、1 平台跳过，维护 4/4、空库 commissioning 1/1，浏览器 40/40（既有服务旅程 29、新 DOM 夹具 11）。

`run-a70e1b64` 当前 Runtime 恢复、校验与照片演练于 20:55:24 UTC 通过，generic 完整基础业务于 21:01:31 通过。随后 Pickup 专项在 preflight 报 `UI_BUSINESS_FAILED`，没有专项业务结果；hongfa 未执行。21:02:11 finally 与 21:05:50 独立 after 确认原环境精确恢复、残留 0。5 份 final 原始 JSON 已独立复核。

该来源树中唯一生成文件 `Microsoft/Windows/PowerShell/ModuleAnalysisCache` 为 4641 字节、SHA `47aa13be80f6357a57f13df6943ccc88246379a0c79b08bf5b277a1b55787136`，20:51:02 已创建，会触发严格源码洁净检查。原失败没有保存更细的异常码，不能追认它为唯一首错。21:12:24 按固定路径/摘要/尺寸归档保留后源码恢复 clean。续验使用单独新脚本，把生命周期 PowerShell 和业务外部进程工作目录移到已验证的私有证据目录；保留 `GIT_CLEAN`、所有业务断言、超时与原 finally，不忽略生成文件。Pickup v2 本地 17 项契约、9 JS 语法及独立审查通过，实机重试待执行。

新 generic 的 6 张合成业务截图已逐摘要核对并目视；取衣结单明确显示金额 0.00、确认禁用、已付 20.00/余额 0.00/交付 1 件。截图不替代连续点击、部分取衣、真实拒绝后重试和全账本专项断言。当前 a2ab `run-ae526778` main-v6 已于 21:12:32 启动，正在串行接续专项。

## 05:48 接续：照片 CSP 修复与服务权限隔离

照片实机失败后，独立 Electron 41.10.6 复现证明旧 app:// 策略拦截 Blob 图像；图片专用允许项修复解码，未放宽脚本和网络策略。图库失败重试、旧异步结果隔离及 URL 回收完成，Web 684/684、Edge 718 通过/2 平台跳过、类型/lint/格式与独立 TypeScript/安全审查通过，内置 SPA 45 项同步。当前分支 `codex/windows-photo-render-20261008`，新的 Runtime 0.1.16 候选准备中，尚未实机验收。

`run-ae526778` 的 hongfa 基础业务通过，additional 在第二件衣物上传后失败；原详细断言未保留。该轮 21:26:26 UTC 独立 after 确认原环境精确恢复，11 份原始 JSON 已复核。

新的 `352f69f5` / `run-c3409477` 于 21:38:50 UTC 在 Pickup preflight 的真实 Runtime status 阶段失败；原 stderr 未保留。只读配对诊断证明同一服务进程的 exe/argv 在 Highest 可读、Limited 为空，不能简单取消身份门禁。finally 的 attention 守卫拒绝恢复，原环境尚未恢复；正在按端口精确进程身份、任务/Counter/维护零残留、专用夹具 SQL 零计数、原任务与安装基线摘要五项核验后执行独立恢复。原 attention 与失败回执保留。

## 06:22 接续：照片修复推送、恢复脚本兼容性修正

照片产品提交 `990c7c745f9936c3a72f596965b7abb70095e65d` 已推送至 [PR #242](https://github.com/manpengan/laundry-desk/pull/242)。新 SPA 摘要 `d22fd188b9c6479d9021d1c339e3e7f2b783b4423ea7f7df7a3843ec220111c3`。双 Windows 安装包 CI 已通过，实际 app:// Blob JPEG 解码断言包含其中；macOS 安装包和 workspace-check 同样成功，真 PostgreSQL 仍在运行。这些 GitHub runner 结果不能替代目标 Windows 实机。

`run-c3409477` 恢复 v1 在任务 XML 预检失败且未产生恢复变更。诊断确认 Windows 导出的默认启用任务省略 Enabled 节点；v2 严格兼容该形式后，22:11:37 UTC 前置检查通过，实际 QA stop 输出 stopped。其退出码复合检查失败，原退出码未保留，不能推断为零。22:13:23 只读记录确认 QA state stopped、pending null、维护 idle、8787/8543 无监听、两个 QA 任务 Disabled；原服务尚未启动。

新 v3 只从已停止状态恢复任务及启动原 Development 服务，不重复 QA stop/start。它保留 18 份原始失败及相关回执，并要求 Disabled XML 仅通过唯一 Enabled 节点变换就精确匹配原 hash；实际无进程、端口及其他任务门禁再次核验。独立审查通过，Windows PS5 解析 4/4、纯契约 25/25 于 22:21:08 通过，22:21:21 单次启动；此记录时仍待终态及独立 after。

新 990 四组专项脚本完成结构审查，补齐私有工作目录及普通权限服务启动的不确定状态守卫，业务断言保持。它们仍是待绑定新产物的草稿，尚未执行，不计为产品通过。

### 06:29 接续：原环境恢复与新候选实际构建

v3 于 22:22:08.685 UTC passed，独立 after 于 22:22:08.631 passed：原服务 PID 1536 ready，原入口/Node/launcher 摘要、3 个任务存在性及 XML/SDDL/启用状态、双原安装 program/registry/shortcut/cache 全部一致，测试进程/UI 任务/QA 引用均为零。18 份旧失败与 attention 保留，未重复 QA stop。5 份原始回执已逐 size/SHA 与恢复/after 关联独立核验；这不是 Pickup 业务通过。

PR #242 HEAD `990c7c74` 五项 CI 现已全绿，真 PostgreSQL 服务 1306 通过/1 平台跳过、维护 4/4、空库浏览器 commissioning 1/1、浏览器 40/40。Foundation 与 Counter 原日志同样下载核对，原生 52/52、双 profile 安装安全/Blob 解码及登录重启各 1/1、macOS 安装包 1/1。

990 Windows 源于 22:25:22 exact clean，旧 352/939 来源也 clean；22:25:37 Session 1 实际构建 PID 13704 启动，22:25:57 进入 Runtime 构建，尚未取得完成结果。仅复用已锁定 runner，不重编译或改动 runner 来源。新机验收从双安装包缺服务 smoke、当前 Runtime 恢复到 hongfa 功能/照片/尺寸/崩溃/维护/视觉/原生窗口，再接双 profile Pickup 与其余专项。

### 06:48 接续：双安装完成与最终 helper 绑定

990 同源 Runtime 与双 Counter 于 22:33:04 UTC 构建成功，Runtime 摘要 `a7caf22ea1af3666238c62c30a571564002ac9f98db1a3702cfb382b8b706b1a`。通用版与宏发版隔离 NSIS 分别于 22:36:58、22:39:21 UTC 完成原安装入口恢复，两组各 7 项对象经原位 DACL 修复后精确复核；初始 restore=false 的历史记录仍保留。8 份安装原始 JSON 已逐字节与 SHA 核验，不计作业务 UI 通过。

测试预检先后拦截两个 harness 问题：诊断 catch 的生成器转义造成 PowerShell 解析失败；以及主机 repo helper 在构建末次重编译后，与早期取到的哈希不一致。两次均未启动新的 QA 业务流程。旧脚本、错误与对应 manifest 已保留；最终 repo helper `8588dba5dc1ee48698456962c38ed3917e9e9c7c4be47d60533d28a6e1a75b5a` 与 sidecar、clean source 已复核，双安装包各自 helper 摘要单独绑定。共享模块 revision3 与四组父脚本完成机械哈希重绑定及独立复审，仍须 Windows 解析和两种权限的原生退出码实测。

U07 空店迁移脚本补齐实际相邻照片夹具及维护 UI 依赖；用真实 native backup 建立 idle 维护记录，备份前后核对 9 张业务/导入表全空，再进入迁移。未知结果由父流程独立闭锁。汇总器收紧关键布尔、空库和双前序成功判定，避免矛盾子回执汇总为通过。上述属于验收脚本修订，尚未计入实机通过。

### 06:54 接续：产品修复普通合并，主线 CI 与实机并行

PR #241 在精确 HEAD `c5eeb80d` 五项 CI 全绿和独立审查后，于 22:53:14 UTC 普通合并为 `c0775430`；PR #242 在精确 HEAD `990c7c74` 五绿和独立审查后，于 22:53:46 UTC 普通合并为 `36710895f27b7a6a319953ca675393ec0c3bb43d`。没有 squash/rebase、绕过门禁或删除分支。回读开放 PR 为 0，`git diff 990c7c74 origin/main` 全树为空。主线四个工作流已启动，尚未取得终态；目标 Windows 仍按真实 provenance `990c7c74` 记录，不冒充 main 的新提交标识。

实机测试启动脚本的正斜杠路径被 helper 的 CanonicalPath 预检拒绝，错误发生在探针任务注册之前；已保留原 stderr、空目录和载体。独立源码核对后，仅将载体专属目录规范为精确本机路径，未修改 helper 或共享模块。Highest Session 1 的 native 0/7 探针已通过，Limited 探针与业务回归继续。产品已合并和 Windows 专项通过分开记账。

后续验收文档在新分支 `codex/windows-release-closure-20261008` 整理，工作区原 6 份文档修改完整保留。

### 07:24 接续：主线真库通过，Limited 调度等待失败保留

main `36710895` 的 Foundation 与双 Counter 工作流均成功；真实 PostgreSQL 工作流于 23:23:10 UTC 成功。最终服务测试 1306 通过、1 项 Windows DPAPI 跨身份平台跳过，日志有数据库零跳过核验；真实数据库维护 4/4、空库 commissioning 浏览器 1/1、服务浏览器 40/40。Windows Runtime payload 工作流此时仍在执行无仓库验收，尚未记为通过。

990 的 `run-47c13d7c` 通过共享模块 25 项纯契约、两种权限的 native 0/7 探针、双安装包 smoke，以及当前 Runtime 的真实备份/校验/删除照片元数据与文件/恢复和演练两项里程碑。上述不重复声称本轮覆盖旧 schema、成对回退或旧控制器。

Highest 控制器的 stop、Limited worker 的 start/status 均原生退出 0，但父控制器持续等待。只读证据显示 Scheduler LastRunTime 比已写入的 stopped-ready 时间早约 17 秒，原跨时钟比较不能满足；没有证据确定系统改时或该差异的唯一原因。23:17:22 UTC 在核验精确 nonce、原始回执摘要、已退出 worker、父进程身份和运行时身份后，仅禁用本轮已结束的专属 worker 任务，使父守卫正常失败退出。23:17:24 operation 明确失败，23:17:51 确认三个控制器进程均不存在；未强杀、未伪造成功、未重放任务。

原 finally 按未知状态守卫保留隔离 QA 服务，原服务此时仍停，须按本轮 1 单 1 照片现场独立恢复，不复用之前空库恢复假设。共享控制器新 v2 保留完整 request/nonce/source/三次 native action 的真实 PID、退出码和文件摘要链，仅将跨时钟比较改为诊断，并使用单调经过时间约束等待；Queued 和尚未运行窗口只能继续等待。52 项纯契约和新父脚本仍待 Windows 验证，本轮不计作 UI 业务通过。

### 07:42 接续：新控制器预检与独立恢复路径修正

新 main9 的 30 个部署文件摘要/尺寸、Windows PS5 20 项解析、9 项 JS 语法和 shared v2 的 52 项纯契约通过，原始回执已独立复核；未进入新的 QA。新 Pickup 的 33 个文件引用、31 个依赖摘要及独立审查通过，本地 19/19 行为契约、9 项 JS 语法与严格 lint 通过，实机结果仍待执行。各专项沿用原业务断言，使用新文件路径，旧稿未覆盖。

恢复 v1 的 5 项 PS5 解析和 37 项纯契约通过，23:34:09 UTC 单次启动后于 23:34:12 在 frozen_receipts 预检失败，尚未禁用 QA 任务或停止服务。原异常和 23:38:43 的 30 路径只读清单共同确认：六个 worker 证据路径漏了目录名中的 `-v1`；前 18 项及六个正确目录下的实际文件均存在、摘要匹配，六个错误路径不存在。原 v1 为 Ready/exit 1、实例与进程均零，原 failed/attention 均保留。

新恢复 v2 仅纠正六路径并固定旧恢复失败原件及旧执行终态，26 项证据绑定、原生退出码与 nonce/PID、停止后进程/端口清空、原任务/服务恢复及独立 after 守卫保持。停止前两次 SQL 核对 1 张订单、0 笔付款、1 张照片和夹具 fingerprint，停止后核对照片字节；不声称停止后又进行了 SQL 检查。新版本已独立审查，尚待本机校验与真实执行。原环境此时仍待恢复，不能将预检绿灯记为恢复完成。

### 07:48 接续：原环境恢复闭环

恢复 v2 的新 5 项 PS5 解析、37 项纯契约和 26 项实际远端摘要核验通过，23:42:35 UTC 单次启动，23:43:37 结果 passed。真实 stop native int 0，nonce/PID 与请求相符；23:43:34 独立 after 确认原服务 PID 5632 ready、原三任务及双安装精确一致、测试进程/UI 任务/QA 目录引用均为零。恢复任务最终 Ready/exit 0/实例零；旧 main8 failed、attention 与 Disabled worker 保留。六份原始回执含 UTF-16 stdout 按原字节归档核验，未重编码。

新 shared v2 的双权限原生 0/7 探针载体完成机械改名与解码 payload 独审，恢复后串行验证；之后从新 fresh-before 进入 main9。恢复完成不代表旧 UI 轮次通过。

### 08:02 接续：新轮次突破等待点并进入业务

新 `run-b993f838` 于 23:48:11 UTC 启动，fresh-before 原服务 PID 5632 ready，990 产品及 939/7248 runner 来源树 clean。shared v2 双权限的实际 native 0/7 探针、30 文件绑定、20 项 PS5 解析、9 项 JS 语法及 52 项纯契约均通过。新 Runtime 两项恢复里程碑于 23:53:11 完成，实际删除照片元数据和文件后恢复；4 份原始回执已独立核验，不覆盖跨 schema 或成对回退。

shared v2 于 23:56:37 真正 completed/pass：普通权限 start/status 的真实退出码均为 0，worker 摘要及 PID 链与父回执匹配，High 后验通过；单调等待 56,208 ms、24 次轮询。6 份原始 JSON 已按远端大小与 SHA 独立复核，未用旧失败轮次代替。后续五组 148 个引用对应 87 个唯一文件，部署摘要逐项匹配、Windows PS5 46 项与 JS 37 项语法通过，只准备环境，没有并发开启业务窗口。

2026-10-08 00:00:45 UTC，宏发基础 functional 通过，保留原 5 秒取衣重载断言，6 张截图生成。additional 照片和尺寸专项此时仍运行，其余专项与最终原环境恢复尚未取得本轮终态。

### 2026-10-08 08:04 后：main9 照片查看器裁切，原环境已恢复

- `run-b993f838` 在 `d03-photo-viewer-close` 失败。两张 blob 照片已解码为 2×2，CSP 与错误提示为空；实际截图显示查看器被玻璃抽屉裁切，右侧关闭按钮落在窗口外。旧脚本未保留原异常栈，因此不推断具体 Playwright timeout。
- 已独立校验 final-raw 12 份原始 JSON 与 3 张 PNG 的 SHA-256/字节数。Runtime 2/2、双 package、Limited v2、hongfa functional 通过；D03 未完成，后续 13 项缺失不得计为通过，另外五组成功前序未满足且未启动。
- `00:04:12.359Z` 独立只读 after 通过：原服务 PID 22732 / ready，3 个任务和双安装精确恢复，本轮进程、UI 任务及 QA 引用均为 0。
- 新分支 `codex/photo-viewer-viewport-20261008` 修复局部查看器 portal、视口边界及嵌套键盘行为，补真实浏览器回归；修复后须重建新 Windows 安装包并从 main 全流程重验。

### 2026-10-08 08:18：查看器修复推送 PR #243

- 产品 `9719af1b4f00016520e6ebfbef5cd7b765595d53` 已提交推送；[PR #243](https://github.com/manpengan/laundry-desk/pull/243) 已关联任务。六份累计验收文档保持未暂存，待最终实机结论再单独提交。
- Web 全量 686/686，类型/lint/构建/格式通过，桌面 SPA 45 项同步和校验通过，manifest `f2eeb3eebd35470ac0c0cbe06d9d1cdade4a38aea6412ac10e6e7c6cd3e0c9e4`。独立 TypeScript 审查及相关 7 项图库行为回归通过。
- Chromium 完整生产玻璃抽屉下旧版 1707×1004 明确出现关闭按钮 `withinViewport=false`、`receivesPointer=false`；修复后 3 个尺寸和焦点/嵌套 Esc 共 4/4。原日志归档 `output/windows-release-closure-20261007/photo-viewer-regression/`。
- 新 Windows 根目录计划 `C:\dev\ld-release-20261008-viewport`，Runtime `0.1.17-win-dev.20261008`。构建与六组独立验收脚本按新源重绑定中，尚未计为安装版通过。

### 2026-10-08 08:29：新源实机构建及安装脚本复核

- 新构建于 `00:24:49.005Z` 实际启动，PID 16808 / Session 1 Limited；`00:25:27.981Z` 原始 live 回执已 root 复核，Runtime 构建阶段、任务 Running、无 failure/final。`00:27:57Z` 后进入 generic Counter 构建，Runtime/入口已产出；最终 helper 摘要仍须等原生测试结束后读取。
- source/build 5 份脚本逐字机械重绑定独立核验，bundle SHA `303561598579d57bbbb20ec4451a910a82b3a0987639dda5f0e324a35aa10e3b`，Git bundle 来源 `9719af1b` 验证通过。
- common/install/operation/runners 20 个唯一文件、21 处引用经独立审查与全量摘要/逆映射核对；Windows 实际 13 项 PowerShell 解析与 6 项 JS 语法通过。新源 939 只读 runner reuse 完成，旧编译器/runner未重建。安装入口仅执行两套安装 phase，旧未部署 qa 分支不作为 main10 入口。
- PR #243 的通用与宏发 Windows、macOS 三项已终态成功并核日志；CI实际checkout为 synthetic merge `d686c4ef`，其父为 main `36710895` 与 PR HEAD `9719af1b`，树 `d3407adf0af817e817111c4b4e8805a97008b832` 与产品 HEAD 完全相同。工作区/真实 PostgreSQL 尚未终态。

### 08:46 接续：新候选安装与前置检查完成，main10 执行中

`9719af1b` 的双 NSIS 于 00:33:52 / 00:36:56 UTC 完成，各 7 项原安装入口及 ACL 精确恢复；首次恢复失败与最终修复回执共 8 份原件全部保留并校验。安装后 app.asar 分别为 generic `c7d12f94f5a01bafd3c1023b5eb3a40d8a5e35f9c2fc9e9bf5110ed456be341e`、hongfa `1a553b3ad987c1fb528dd38a588ab4c4aeb84997569772e5cd041d8cc6f121e6`，与 EXE 摘要分开记录。

独立复核 final QA 的 78 个文件与实际部署逐项一致，45 项 PS5 解析、30 项 JS 语法、52 项纯契约、High/Low Session 1 的真实 native 0/7 全通过；双安装树的 45 个 SPA 资源和 helper/EXE/ASAR 来源一致。Windows 原生测试数值投影与保留的原始结果逐字段相等，共执行 40 次（helper 4 项重复，不重复计为独立用例）。939 和 7248 runner 只读重新绑定产品来源，未假称本轮重新编译。

main10 `run-6a0f187f` 于 00:43:10 UTC 单次启动，执行前原服务 PID 22732 ready；前置 8 份原件见 `windows-9719af1b/main10-preflight-raw/`。Pickup v5 的 33 个文件、31 个依赖摘要及实际双安装来源已完成两方核对与独立审查；须在 main10 成功且原环境独立恢复后，再依序执行 Pickup、业务补充、强杀/离线恢复、坏备份负例和 U07，不能据脚本预检关闭业务项。

### 08:58 接续：PR #243 五绿普通合并，当前开放 PR 清零

精确 HEAD `9719af1b4f00016520e6ebfbef5cd7b765595d53` 的五项检查全部成功。PostgreSQL 原日志核实：1307 总项中 1306 通过、1 非数据库平台跳过，并有 `PG_DATABASE_TESTS_VERIFIED`；真实数据库维护 4/4、fresh commissioning 1/1、真实服务器与 PostgreSQL 浏览器 44/44。CI 构建来源为合成 merge `d686c4ef3c231e631b2a27f4255e4a3053ef169a`，其父提交是367与9719，完整树与产品相同。

00:57:57 UTC 通过普通 merge 合并 PR #243，产生 main `fad33482fbf623cebc6870de0653700119b76594`，parents 为367和9719。root fetch 后核对完整 tree `d3407adf0af817e817111c4b4e8805a97008b832` 相同、无文件差异；开放 PR 为零。未 squash/rebase、未删除分支、未绕过门禁。当前验收文档分支已快进至该 main，六份既有文档改动逐摘要保留。

[Foundation](https://github.com/manpengan/laundry-desk/actions/runs/37706970364)、[PostgreSQL](https://github.com/manpengan/laundry-desk/actions/runs/37706970362)、[Counter](https://github.com/manpengan/laundry-desk/actions/runs/37706970340) 全部成功。新 main 四组 CI 单独监控，实机仍沿来源9719和现有 run 执行，不重标候选来源或把合并当作完整 UI 验收。

### 09:04 接续：照片实机通过，D04 后段失败及恢复均保留

`run-6a0f187f` 的D03于00:57:38 UTC通过，宏发基础功能00:56:27通过。root核验4份JSON与8张PNG，查看真实照片弹窗、重开订单与1024×600焦点截图：关闭和删除按钮均在视口内，原图已解码；第二件绑定及正常关闭重开断言通过。1024×600、1280×800两种content尺寸通过，保持150%DPI，不外推多DPI或IME。

随后D04在 `new-identical-operation` 阶段报 `D04_CHECK_FAILED`，00:58:57记录失败，00:59:26 controller失败终态。原catch只留下固定总码，私有146B日志也只有该码，没有原异常或database-checkpoints；无法唯一判因。新诊断只准备细分该阶段和受限私有异常，不先改生产、不削弱业务断言、不覆盖旧冻结脚本。

原finally确认服务恢复，无维护/窗口/柜台残留或恢复错误。01:00:56.993 UTC独立after核实原服务PID4636 ready、三任务XML/SDDL/启用状态与双原安装完全一致，测试进程/UI任务/QA引用均零。13份终态JSON逐大小与SHA复核归档；后续generic业务、维护、视觉、原生关窗等未完成，不记通过。main10失败不作为后续五组成功前序。

### 09:41 接续：独立D04通过，完整main11重验；Win11资源恢复

独立 D04 诊断 `run-64fe4489` 于01:26:57 UTC通过：强杀后同用户恢复、原操作恰好1单1付款500分、再次同内容开单使用新键，三阶段数据库集合核对通过。01:28:49独立after确认原PID14168 ready、三任务与双安装精确恢复、残留零。10份终态和5份私有原件已逐摘要复核；该独立链不替代完整main，旧失败根因仍未确定。新main11保留完整原执行顺序并加入私有诊断，后续五组仍严格要求main11成功前序。

root与独立审查均核对main11的30个文件、4个PS载体精确变换、a159诊断JS同体、原finally及ZIP摘要；保留双包→Runtime→基础功能→照片/挂单小窗→D04→维护→视觉→原生关闭顺序。Pickup新载体33引用、15个自有文件机械重绑定及原安装摘要均复核，实际执行仍等待完整main11成功和独立恢复。

新 main `fad33482` 的 Foundation、Counter、真实 PostgreSQL 均成功；Runtime 原生生命周期仍执行中。旧main367的25场景日志已独立核验，分别归档，不转记为新main通过。

2026-10-08 01:17:51 UTC已重新实测Tailscale直连公网IPv6并以固定主机密钥登录Linux，旧IPv4路径阻塞已解除。精确Laundry Win11 QA的QEMU PID65511、名称和磁盘身份匹配；一次无按键/无点击的鼠标移动唤醒显示后，01:27:50截图确认laundrytest桌面已解锁、PowerShell空提示。旧安装仍非本轮9719/.17，仅确认资源可用；当前开始只读清点并准备隔离安装。另一台virsh win11虚拟机未启动或改动。

### 09:50 范围收敛：完成Windows10后结束

用户明确指定Windows10测试完即结束。停止Win11后续传输、安装与测试，只完成已在途只读命令的终态确认；旧Runtime、VM和介质均未更改。Windows10现有main11及五组专项继续，失败先定位和恢复，不盲目重跑；最终验收文档按实际结果提交推送并普通合并。

main11 `run-ec3424fb` 于01:38:58 UTC启动。实际30pins/20PS5/9JS、三源clean和双安装摘要核验通过。4份Runtime原件已独立复核：双package、当前版真实数据库与照片删除恢复、同源入口通过；shared-v2于01:47:37完成，普通权限start/status及端口进程身份通过。主轮UI继续。

## 2026-10-10 工作区记录补交

此前六份未提交记录已随本次整理补交，原始文件、差异补丁及全部 Git 引用已在仓库外备份。上文“当前”“在跑”只保留当时状态，不表示本轮正在执行。后续验收已转交并记录在[Windows 10 续验](../pilot-readiness-20261008/windows-acceptance.md)：`5db094aa` 的 D04 两轮通过但维护刷新失败，修复后的 `5587b003` 主流程三轮失败，维护单项诊断仍有窗口就绪失败；各轮恢复均按原记录保留。GitHub 输入已到 `c815bc7f`，本轮仅整理、核对与合入记录，没有新增实机通过结论。
