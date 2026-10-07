# 进度

更新时间：2026-10-07 22:08（台北）。

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
