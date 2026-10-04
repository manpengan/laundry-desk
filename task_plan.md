## 当前收尾（2026-10-03）

1. [x] A1–A9/B1–B8 在范围代码与产品入口实现、独立审查、按功能提交推送；打印除外。
2. [x] 全工作区门禁与定向真实数据库验证；固定 LOCAL 测试使用独立 fixture，保留 CI 主库。
3. [ ] `6273a02b` 的三套 CI 已通过；实机发现的迁移/导出上下文修复 `3a6d987d` 已推送，真实 PG 11/11 和 CI 同组 4/4 通过。后续 CI 测试发现加载顺序修复 `6a26d274` 真库 2/2、无构建产物发现正常跳过及独审通过，6a 的 workspace/macOS/PG 已通过，Windows 仍执行；dacc 柜台显示修复最新 CI 单独确认。
4. [ ] `ff83cbde` 物理原生 25/25、已安装组件真库 15/15 通过；g3 暴露实际迁移接线错误，原环境于 12:36 UTC 恢复且失败现场保留。`3a6d987d` 双发行包和 Runtime `0.2.1` 已构建、下载并逐文件核验；g5 迁移导出/离线 AI 已通过，g7 八项及四 GUI 通过、14 截图和原环境恢复均复核；dacc 柜台标签修复待两发行定向实测，Runtime不变。
5. [ ] 更新精确源码、包摘要和验收记录，列明真实渠道、硬件和正式发行外部条件。
6. [ ] 按用户最新授权，将本仓库所有已实现功能合入 GitHub `main`；保留功能批次提交记录，并满足受保护分支门禁。
7. [ ] 已确认历史 12 条 GitHub 与 5 条本地临时分支完整保留在 `main`，按精确 SHA 保护删除；当前功能分支待合并后删除。保留历史 WIP 备份与 detached 工作树，不恢复已暂停 Cloud 路线，不修改 Gitea。

# 当前交付：A1–A9 / B1–B8 全功能补齐（2026-10-03）

用户授权多 agent 实现全部功能，按功能批次提交推送 GitHub，最终编译 Windows App 并 SSH 安装验证。
打印机及钱箱暂缓；Cloud 开发部署继续暂停。短信使用阿里云，仅合成数据和协议夹具。

- [x] A1–A9 核心、维护与恢复入口分批提交推送，维护最后一批 `d447c3c`。
- [x] B1 阿里云 `4fa586e`、B5/B6 AI `d6eaecc`、B7 电子秤 `7e9a662` 已推送。
- [x] B2 支付协议、账本、退款、对账及柜台组件 `8fa5d82` 已推送；独立真库4项通过。
- [x] B8 只读远程协助核心、维护配置及柜台组件 `084abf7` 已推送；协议/真库/Windows原生输入通过。
- [x] B4 原生小程序前端 `c6d3edb` 已推送；13项回归、原生WXML/WXSS编译通过。
- [x] 干净CI暴露的小程序构建依赖已修复推送 `ad59b29`，任务图及回归通过，CI复跑中。
- [x] B3 身份与自助交易：数据库资料修改签名证明已修复，完整动作真库回归及独立复审通过。
- [x] B1 微信订阅发送：固定模板配置、人工确认、一次同意消费、回执和恢复清理已实现，独审/真库回归通过。
- [x] 公共桌面/HTTP注册、连续0077–0079迁移、SPA资源与文档完成最终集成提交。
- [x] 完整 workspace 和真实 PostgreSQL 门禁通过；CI 暴露的构建与测试环境问题另行修复后冻结源码。
- [x] 从独立干净Windows目录构建 `ff83cbde` generic/hongfa NSIS 和完整 Runtime；包检查与脱离源码 smoke 通过。
- [ ] 最新安装包的 Windows 原生维护、功能与 GUI 验收。

Windows物理机构建目录已准备，依赖和三份官方材料已缓存；旧仓库默认168项变更与运行服务保留。
最终安装版验收已新增支付、小程序、短信、AI、远程协助五条实际IPC读取检查。
当前Runtime本地185项中161通过、24项平台/真库跳过，不能替代Windows安装态。
外部账号、实际AppID、商户、模型、MFA支持端、电子秤实物与正式签名仍分别记录，不记作通过。
PR #229 保持draft，未合并；功能和验收状态见[分批清单](docs/operations/2026-10-03-windows-full-feature-batches.md)。

以下为此前验收历史，保留原始失败与通过范围；其当时的“当前”状态由上方新计划接续。

# 历史交付：Windows 全功能开发与安装版测试（2026-10-01）

## 2026-10-03 00:28 UTC 当前检查点

尚未完成。本节是最新状态，下面各时间点保留当时的结果与失败记录。

- 当前状态：`remaining_acceptance_blocked_by_transport`。连续只有直连 IPv4，本次许可未到，
  已安全停止新来宾操作。Runtime 最后确认 `.8`；casefix 第 4–5 步只读校验已提交但终态未收取，
  没有新的绑定器、SourceCheck、打印 Run 或升级。三个后续 ISO 上传和摘要核验完成，仅属准备。
  后续按[安全停止交接记录](dist/windows-f7771d9-20261003/evidence/windows11-final-acceptance-transport-handoff.json)
  先读原终态；IME 双发行通过结果保持。[公开接续材料](dist/windows-f7771d9-20261003/acceptance-handoff/README.md)已归档。
- 本轮核对本地 `main`、`origin/main` 与 GitHub 均为 `f7771d9`，workspace-check、
  runtime-app-macos、real-postgres、windows-runtime-payload 四项 CI 均为 success。
  下列未提交修复不因此获得新的完整 CI 通过记录。
- Windows 10：同 F 产物的旧 3 项与新 10 项共覆盖 13 项维护，两种安装版四项核心旅程全部通过。
  独立后检已完成，原工作区、任务、健康服务、原八份备份及两版 ASAR 保留，测试 Companion 已停止。
- Windows 11：安装、升级及四项核心旅程通过；中文打印机枚举通过。打印绑定器实际退出 0，
  SourceCheck 的旧失败保留；修正测试工具的 PowerShell 5.1 参数变量及中文源码 BOM 后，
  新 SourceCheck PID 2540 正常退出 0、输出管道关闭，未启动产品。既有 Run PID 3084
  在业务进入前转为 `UNKNOWN_HOLD`；旧 Node/owner 已按精确身份受控回收，退出 -1、双管道关闭，
  原现场保留、不计为测试通过。系统目录大小写误拒绝根因已确认，
  修正工具的 20 项本地回归与独立审查通过；新 Windows 软件打印仍待实测，不重复旧运行。
- IME4：Windows 11 generic/hongfa 安装版各 1 passed，0 failed/skipped/flaky，原生退出 0，
  控制器与双管道正常关闭。每版 14 个事件、可信开始 1/更新 6、结束与预期提交总数各 1，
  最终文本符合预期、未保存客户；结束总数不等于可信结束数。精确引擎与脚本派发审计等严格门禁
  由绑定代码强制验证，先前所有失败记录保留。IME4 介质 1,305 文件已完整回读。
- GUI：两个修正入口的 8 份生成脚本已在 Windows PowerShell 5.1 全部解析通过，旧错误成功复现。
  修正 `.9` 测试介质和独立 `.10` 完整候选已完成本地校验；尚待实际安装、GUI 和最终登录自启。
  `.10` 仅改变发行元数据与已审 GUI 入口，Counter 和实际 payload 保持 F，明确为未提交修复候选。
- 后续执行范围：两个 profile 各自卸载重装；共享 ASAR 的离线重放/真实托盘各一次；
  `.9` 分发源码入口 GUI、最终 `.10` 安装后 GUI；`.9 → .10 → .9 → .10` 升级回退链和最终登录自启。
  原 `.9 → .8 → .9` 及重复安装后 `.9` GUI 计划取消，不把共享测试夸大成逐 profile 验收。
  本轮继续暂停云平台；实体打印机缺席不计为通过。当前源码修复尚未提交或推送。
- 核心旅程与 IME 已有实机通过记录，剩余验收仍待结果；有限记录见[交付记录](docs/operations/2026-10-01-windows-full-feature-delivery.md)。
  剩余操作等待可用 IPv6 恢复或本次 IPv4 许可明确，不将传输准备计为部署验收。

## 2026-10-02 17:48 UTC 当前检查点

尚未完成。最新 Windows 11 核心四项通过记录继续有效；以下失败与修复不能记作已通过。

- 原生微软拼音已在柜台实际输入“你好”，IME 测试仍失败。补充有限布尔/计数失败诊断，
  保持可信 composition/input 断言不变；独审发现诊断读取可能阻塞清理，已补固定 2 秒时限，
  正在复审与准备新实机测试包。
- Operator GUI 失败已定位到 `runtime-entry-ui.ps1:95`：PowerShell 5.1 将双引号字符串中的
  智能双引号识别为分隔符。实机原文件 `UnexpectedToken` 行号确认；源码修复不改变文案。
  已补生成入口与全部 GUI helper 的 WinPS 5.1 ParseFile 回归；Mac 的 5 项纯测试通过，
  7 项 Windows 测试明确跳过。两个入口已从原封存 payload 重打，标记为 F 基线加未提交修复，
  等待原生解析及 GUI 复验；旧包保留，不能作为可交付完成版本。
- Windows 10 接续在实际正常 start 退出 0 后，被测试脚本错误要求 `stopped` 而中止。
  已修正 start/upgrade 期望 `running`，13 项原函数 Windows 回归通过。正常 stop 与原任务
  Enable/Start 均成功；恢复观察器随后报任务定义变化而挂起，独立后检确认当前定义/权限、
  旧服务 ready、19 项来源、8 份备份、两个 ASAR 和原 168 项工作区变更保留。
  此轮秘密 RAM 后比较未完成，明确不可得；正释放精确自有 holder 后继续剩余 10+4。
- 云平台暂停、实体打印未验收的边界保持。
- 17:58 UTC：Windows 11 普通账户的实际原生中文打印机枚举退出 0，安装与助手来源匹配、
  严格 UTF-8 JSON、两队列且固定中文测试队列存在；Root 已读有限 JSON 并核对截图。
  尚未发送 RAW。新的 IME 诊断 UDF 介质 1,304 文件逐项回读通过，已交实机 owner 接续。
- 18:01 UTC：Windows PowerShell 5.1 原生解析回归退出 0；两个修正入口共 8 份生成脚本
  全部零解析错误，原 UI 的 `UnexpectedToken` 第 95 行成功复现。未执行 GUI/产品/任务。
  修正 `.9` 将通过正常升级进入新 Programs 目录，随后分别核验分发包 GUI 与安装后快捷方式；
  原 `.8` 目录保留，不手工覆盖。
- 18:13 UTC：Windows 10 新接续正常完成：剩余 10 项维护全部通过，两个 profile 的
  Runtime/Functional 四项均 1 passed / 0 failed、skipped、flaky；外层正常恢复确认。
  Root 已读取原始有限报告并按摘要留存。维护覆盖为旧 3 项加新 10 项，不是单次全 13 项。
  最后独立资源保全检查仍在执行，锁屏状态不算可见 GUI 验收。
- Windows 11 新诊断明确 IME 未通过原因是缺少可信 `compositionend`/预期提交事件；
  `hasExpectedText` 为真、组合开始/更新/输入可信且节点未替换，无溢出。后续保留断言，
  在原生输入后明确移到空手机号框结束姓名输入来复验，禁止把“显示你好”直接算通过。

## 2026-10-02 17:16 UTC 当前检查点

本轮仍在执行，尚未完成全部 Windows 软件验收。当前源码为
`f7771d9e8225de52b899d18be5409b5a799c2d8a`；该源码四项 CI 已通过，Windows 已重新构建
generic/hongfa Counter 与 Runtime `0.1.8/0.1.9-win-dev.20261002`。

- Windows 11：两种 NSIS 安装和 Runtime `.4 → .8` 升级均已退出 0；两个 profile 的
  Runtime/Functional 四项安装版旅程全部通过，零失败、跳过或重试，控制器与管道关闭已确认。
- Windows 11：首次 IME 检查被 `IME_READY_PROCESS_INVALID` 中止，尚未输入中文。
  已确认 Playwright 在 Windows 上返回的启动进程是命令壳；实际 Electron 主进程的父 PID
  与旧 READY PID 一致。测试已改从 Electron 主上下文读取 PID，类型检查、lint 与格式通过，
  独立 TypeScript 审查通过；修正后的首次复验取得真实 PID，但输入法仍为英文，已保留失败。
  随后在原生临时输入框校准出“你好”候选；最新柜台复验已 READY，尚未输入拼音时连接
  转为技能禁止的 IPv4，终态待恢复 IPv6 后读取，不重放未知操作。
  真实托盘菜单、operator、离线重放、卸载重装、OS 登录自启、
  `.8/.9` 升级回滚及软件打印仍待实际完成。
- Windows 10：本轮两种 NSIS 和首次 Runtime 升级退出 0；13 项维护在第 4 项
  `scheduled-task-start` 失败，后续四项业务未执行。失败后曾确认任务 Ready、零实例且返回 0，
  Runtime `.8` running、pending 为空、维护 journal idle；这些事后事实不改写原失败结果。
  已按普通用户正常停止 Companion、高权限恢复原开发任务的独立流程恢复，两个控制器均
  正常退出 0。独立后置核验确认旧服务 ready、原工作区 HEAD/168 项改动、任务定义和权限、
  8 份备份 manifest/dump 与两个安装版 ASAR 保留；当前 Companion stopped/disabled，旧服务
  ready。旧测试 holder 已受控结束，不计为原 QA 正常退出或通过。剩余 10 项维护加 4 条业务
  接续脚本修复 COM 观察和报告数组复制，通过独立审查、本地 26 项与 Windows 原生 14 项回归，
  新运行前检查进行中；旧 3 项通过与新 10 项实际结果分开记录。
- Windows 10：CIM 与 COM 的同一任务 LastRunTime 实际相差 47 秒，原因调查继续；
  尚不能把该差异等同于原测试失败根因。旧 holder 的秘密 RAM 快照不可访问，恢复时另建
  RAM 基线，只能验证恢复前后保全，不能宣称重证整轮秘密字节未变。
- 软件打印：最终绑定器 v2 已修复发行版本数组被隐式转换接受的问题，15 项本地回归、
  TypeScript/安全独立审查通过；只读介质逐文件核验完成。Windows 原生 holder 的 11 项
  合成探针已实际退出 0；中文队列只读枚举与最终打印仍待实际执行，不计为出纸验收。
- 本地保留产物已放入 `dist/windows-f7771d9-20261003/`：两个 Counter 安装程序、两个完整
  Runtime ZIP 与摘要索引。两个 ZIP 各 6,439 文件均写后回读匹配可信介质；安装版验收仍进行中。
- 云平台继续暂停。实体打印机缺席、安装包仍为未签名开发版；均不计为已验收。

以下记录保留各自源码和运行范围；旧 `8284470` 的通过结果不替代上述最新源码的待测项。

用户已授权完成后续 1–5、编译部署 Windows 并测试；随后明确暂无实体打印机，其他项目自主操作。
既有已授权 Git 交付记录保留；当前新增修复尚未提交或推送。旧工作区、数据和共享服务继续保留，根 V1 继续冻结。
用户随后明确取消云平台开发和部署，本轮不执行 ADR-65 云生产环境工作；Windows 本地功能继续交付。

- [x] 两项安装修复与私有凭据测试入口经独立审查和四项 CI，PR #223 普通合入主线；
      后续发行仍绑定最终合并后的精确源码。
- [x] 独立中文 Runtime 入口、宏发发行 profile、实际托盘图标及安装版回归已实现；
      PR #224 对应四项 CI 通过，以普通 merge 合入 `4592e4dc41af5b2ee5ffdeec18601d8b537c08fc`。
- [x] 从该精确主线的独立干净 Windows checkout 编译并检查 generic/hongfa Counter `0.1.1`，
      生成两个 Runtime 开发版本及独立入口；四份产物与公开测试封装摘要已核对。
- [x] CRT 修复合入 `828447094fe741ddc2e49c6b938e53194da55a52` 后，在另一独立干净 Windows
      checkout 重新构建两种 Counter `0.1.1`、Runtime `0.1.4/0.1.5-win-dev.20261002` 和各自入口；
      两个 Runtime 均在源码仓库外通过实际加载检查，7 个 PostgreSQL 工具及原生密码模块正常。
- [x] 实现发行绑定的独立中文 Runtime 安装/维护入口、Counter 安装引导和宏发严格发行 profile。
- [ ] 完成上述主线产物的无源码/普通用户实机验收、软件打印链与受控开发版分发记录。
- [x] 新建正常安装的 Windows 11 隔离测试环境，完成普通账户首次登录及原生 150% 显示设置。
- [x] 完成该隔离系统的正常重启、普通账户密码重新登录及原生 Session 1 / 150% 复核；
      Runtime 安装后自启仍为独立待测门禁。
- [ ] 完成安装后的 Windows 重启/登录自启、真实中文输入与第二版本升级回滚；签名和实体打印分别记录外部条件。
- [ ] 完成 Windows 功能回归、维护说明与受控开发版交付记录；云生产部署已移出本轮范围。
- [ ] 补齐实际托盘图标/最小化恢复、第二实例与正常关闭、卸载重装保留状态，
      以及原生 DPAPI 离线队列跨 Counter 重启与恰好一次重放的软件门禁。

状态只以新鲜源码、CI、安装包与对应实机/远端证据推进。硬件不可用不记为通过；真实顾客数据仍不导入。

2026-10-02 最新实测：Windows 10 两种安装版 Runtime/Functional 四组均已通过；Windows 11
两种 NSIS 已安装，通用 Runtime 单次 1 passed、0 failed/skipped/flaky（43,649 ms）。
Windows 11 Functional 实际退出 1，控制器与管道已关闭，后续 IME/operator/offline/reinstall 未启动；
账户交接存在、六阶段截图缺席，原 reporter 内存已释放，补充有限诊断后再按新 scope 验证。
打印 V3 独立源码审查通过，但原生准备回归在 ACL 夹具失败，RAW 27 项未到达；实际 AST
内存诊断证实字符串拼接拆项及 FileSecurity 的 OI/CI 规范化，正在仅修正测试夹具。
Windows 11 首轮系统语言门禁误拒绝已修复，新的实际条件 25 项在 Windows 10/11 均通过。
云平台继续按 ADR-71 暂停；当前 main 文档合并 `b6e6d7f` 与已编译 `8284470` 的活动代码子树相同。
打印夹具第二次修正实际通过全部 53 项（26 validator、27 RAW）、四项摘要和三项语法，
没有产品或原生子进程；生产验证函数不变。Windows 11 服务只读复核 ready、柜台进程为零，
新的有限 Functional 诊断入口已通过原生两项回归，保留旧失败后单独接续一项。
现有 Windows 10 中文软件队列另实证旧助手输出不是有效 UTF-8：生产调用出现替换字符及名称
失配、原始 130 字节严格解码失败，两个只读助手均正常退出。原生 UTF-8 writer 修复与真实
Main/JsonString 反射回归已获 C# / TS 独立审查，本地包 7 passed、0 failed、2 Windows skipped；
原生旧版 1 failed / 新版 1 passed 已确认；新编译助手的 UTF-8 与 Buffer 两次只读枚举
均退出 0、严格 UTF-8/无替换字符、五个系统队列名称集合一致（含一个非 ASCII）。
旧安装助手和队列保持原状，新源需重新打包部署，旧主线打印仍不记通过。
Windows 11 单次诊断已确认 Functional 的真实失败为高度 640 对 609（AS_LAUNCHED_LAYOUT，
32,358 ms、0 passed/1 failed/0 skipped/flaky）；退出/管道关闭已确认，服务 ready、测试进程为零。
具体工作区原因仍待 native 数值测量；新测试已按对应窗口的真实工作区推导高度，保留
普通 640、宽度 900、native 最小尺寸、renderer/content 一致性及全部控件可见断言。
四项回归与 Edge 脚本 119/119 通过；最新安装版实测待执行，失败现场保留。
UTF-8 修复的完整 workspace:check 已实际 CLI 0；几何测试更改之后另跑相应 Edge 门禁，
最终 CI、四份产物和新版安装实测仍按精确新源码接续。
几何回归已改静态严格 JSDoc 模块，修复实际 authority 导入失败；foundation 57/57、
几何 4/4、TS/lint/格式新鲜通过，没有门禁豁免。原生编码测试接入 Windows CI。

PR #228 首轮 workspace、macOS、真实 PostgreSQL 已通过；新接入的 Windows platform-fs
九项测试实际为 8 passed / 1 failed，首次私有目录测试在创建权限前失败。
独立 Windows 原生复核确认 unchanged CanonicalPath 拒绝实际 8.3 路径别名
（InvalidOperationException / 80131509），接受完整路径；Node realpath 解析为该完整路径后通过。
测试夹具只将临时目录先 realpath 再 mkdtemp，生产路径和 ACL 校验保持；
修正后的完整九项测试已在独立 Windows 合成目录实际全部通过，0 failed/skipped、原生与 CLI 退出 0；
新 CI 仍待复跑。
打印环境旧单次创建在 SET_PRIVATE_QA_ACL 失败，现有固定目录为空、QA 所有且有五条继承 ACE；
仅修复该已存在 QA 目录 DACL 的候选已实际通过 20 项原生内存回归，实机单次采用及读回待完成。

当前补充验证：Edge-agent 540 项通过；离线验收加入控制器失败后停止自动恢复的门禁，
纯回归与独立安全复审通过，原生 DPAPI 跨重启结果待实机执行。Windows CI 的 87 项原生测试
全部通过，但模拟用户目录缺少 AppData 导致 PowerShell 缓存写入源码工作目录；实机有限实验
已确认根因。补齐测试目录并绑定 fixture 工作目录后，Windows CI 17 个源码检查点全部干净，
原生验证与 Runtime 编译打包通过；后置无源码状态查询的安装顺序已修正，PR 与最终主线完整生命周期验收均已通过。

PR #224 修正后的 Windows CI 已完成无源码二十场景和严格后置 `uninstalled` 查询。
该 PR 的测试合并源码与最终主线代码树一致；主线独立构建已完成，主线 push 的工作区、macOS、
真实 PostgreSQL 和 Windows 生命周期 CI 四项均已通过。Windows run `36876259342` 的原生 87 项、
无源码二十场景及严格卸载后状态全部通过。真实 Windows 10/11 的新主线安装版、
GUI、中文输入、OS 登录自启、离线与卸载保留门禁仍待对应实测，不能用构建或场景发现替代。

安装验收封装的实际 Windows PowerShell 校验已通过：10 项语法、21 项文件摘要及 43 项协议/结果保存纯回归。
完整 Programs 树的流式比较补充 37 项回归并经独立审查通过，原生卸载重装仍待执行。
实机交互入口的只读探针通过 154 项纯回归；实际进程路径、账户与两类句柄释放均已确认，
但普通账户无法读取高权限进程命令行，入口来源绑定仍待修正与实测，不记为安装门禁通过。

新的入口来源保护保持实际进程身份检查，使用不可写的来源记录绑定同会话高权限控制器。
Windows 10 已通过 19 项源码摘要、15 项语法、382 项纯回归及 15 项生产源码检查；
独立文件保护探针先后通过 8 项摘要、7 项语法、192 / 215 项纯回归及真实控制器只读检查；
两次原生探针未完成，失败现场保留，不计通过，尚未切换旧业务服务。
Windows 11 已逐文件校验全部 15833 项公开测试封装；普通用户首次安装 Runtime 失败，
有限只读检查确认状态停在 staged、数据库目录尚未建立，且系统未提供 PostgreSQL 需要的
Visual C++ 运行库。`initdb --version` 与 `postgres --version` 实际均返回 `0xC0000135`。
现已实现固定来源的完整 12 个 x64 CRT DLL、两处应用目录副本、许可证和严格发行清单绑定，
首次安装在状态/凭据/数据库创建前验证 5/7 个 PostgreSQL 工具及原生密码模块。
本地 Runtime 新鲜验证 114 项：97 通过、17 Windows 专项跳过、0 失败；
CRT 新源码独立 JS/安全/历史版本复审通过；Windows 实际固定来源提取、12 个 x64 DLL 的两处副本
与发行清单核对通过。PR #225 的工作区、macOS、真实 PostgreSQL、Windows 无源码生命周期四项
CI 均已通过，以普通 merge 合入 `828447094fe741ddc2e49c6b938e53194da55a52`；合并代码树与审查
源码完全一致。该主线独立 Windows 四份新产物构建已完成，安装复验进行中；主线 push 的工作区、
macOS、真实 PostgreSQL 与 Windows 无源码生命周期 CI 四项均已通过；Windows run `36936205584`
已在 2026-10-02 00:02:17 UTC 完成。
新的合成保护探针已在 Windows 原生执行并独立复核：8 项摘要、7 项语法、244 项纯回归、
7 项实际写入/删除/替换/移动拒绝均通过；测试进程和任务已退出，旧业务服务保持 ready。
失败探针的测试占用已按对象绑定解除；专属进程/任务缺席与旧服务健康已独立复核，
所有失败现场文件继续保留，失败不计为通过。
旧失败目录保留，未重试旧安装或记为通过。

最新主线公开产物归档已独立逐成员验证：13,153 个普通文件的大小与 SHA-256 全部匹配，
1,150 个目录及全部 14,303 个成员类型、唯一性与安全路径检查通过；归档前后摘要一致。
重绑定后的 Windows 10 安装验收封装已实际通过 19 项文件摘要、15 项 PowerShell 语法、
382 项纯回归与 15 项生产源码检查。此处仅记录封装检查，安装维护和业务测试继续独立执行。
Windows 11 新介质已生成四份发行绑定，147 份复用源码逐项核对与最新主线相同；
普通用户安装与系统交互验收仍待实际执行。
Windows 10 已实际通过两种 Counter NSIS 安装、Runtime 第一版本升级与 13 项安装维护场景；
首个业务测试因私有验收封装指向不存在的 Playwright CLI 路径，在业务断言前退出。后续三项未执行，
不记为业务通过。旧开发 Runtime 已恢复 ready，原工作区 168 项变更与原四份备份仍在；
失败报告和测试源保留，正在修正独立测试入口。
Windows 11 新公开介质 15,889 个普通文件与只读挂载 ISO 全部逐文件 SHA 校验通过。
纯测试封装的历史文件路径依赖已改为精确公开源码摘要，Mac 辅助 37 项通过；
Windows 普通账户原生纯测试与后续安装仍待执行。测试虚拟机的符号链接能力预检返回 EPERM，
正在仅为隔离环境配置原生测试所需能力，实际安装与业务继续要求普通账户。
Windows 11 普通账户已实际通过新介质全部 15,889 个文件摘要校验；新的准备脚本随后已知失败，
未启动原生纯测试或业务，不记为通过。独立测试宿主重启后该虚拟机曾离线，现已从原磁盘正常恢复，
保留磁盘、NVRAM、TPM 状态与失败现场，继续只读定位准备失败；此中断单独记录，不追加产品失败。
Windows 10 失败测试入口的单个保锁控制器已按精确进程对象解除；独立复核原任务和全部测试文件保留、
旧服务 ready、旧工作区 168 项变更及 8 个精确备份目录名集合仍在。四组修正后的业务测试配置
已实际加载并各发现一个测试；新的独立封装随后实际通过 19 项摘要、15 项语法、382 项纯回归，
以及固定的 226 个公开执行依赖检查，正在进入四组业务旅程。此前 13 项维护结果仅引用精确摘要，
不重复执行安装器、升级或 SQL 维护场景。
四业务封装随后实际进入普通 Session 1：首个 generic Runtime E2E 进程退出码为 0，
但私有报告读取器拒绝统计格式，尚未确认测试计数，后三项未执行。旧开发服务已再次恢复，
六项保全核对均通过，原八份备份保留；正在定位报告读取器，失败封装与报告继续保留。
实际定位为 Windows PowerShell 5.1 将合法小数耗时解析为 Decimal；新的私有读取器仅补该类型，
保留原范围及全部拒绝条件，并增加六项实际函数回归。首组 Playwright 完成标记已确认 passed、
失败列表为空，完整四组计数仍待新封装实跑。原保锁控制器的精确单进程恢复已完成，
任务、父进程和所有现场文件保留，旧服务 ready；新封装独立 19 源码摘要和 24 项依赖绑定核对通过。
Windows 11 已正常重新登录普通账户；原准备现场的 29 项源码大小和摘要全部匹配，
解包及私有目录权限已完成，正在只读检查 11 个 PowerShell 脚本的同内存解析。
新 Decimal 封装已实际通过 19 项源码摘要、15 项语法、388 项纯回归及 226 个公开执行依赖；
六项新增回归均使用实际读取函数，包含小数有效值、上下限及非法类型。
单个失败保锁控制器恢复后的源码/任务/旧服务/八份备份保全已独立复核通过；
新 scope 已进入四组业务旅程单次执行，完整结果仍待实测返回。
Windows 11 实际确认四个 BOM 脚本的准备解析问题：同句柄、原 SHA 不变，读取文本仅去掉
开头 U+FEFF 后，11 个脚本全部零错误，三个参数块恢复正常。修正仅限私有准备器，
29 份原源码及安装包保持；新的小封装复用已校验的公开归档，继续普通账户原生纯测试。
Windows 10 新 Decimal scope 的实际业务计数已核对：generic Runtime 与 Functional 各 1 通过、
0 失败/跳过/重试；hongfa Runtime 失败，截图证明初次登录及安全/健康检查通过，
具体失败点仍待有限诊断，第四组未执行。旧服务恢复 ready，六项保全均通过；所有失败现场保留。
Windows 11 BOM 修正小封装的三项原生语法和五项实际读取函数回归通过；4 个公开文件
70,618 字节的只读 ISO（1,175,552 字节）已逐文件核对并单次送达测试机，原公开大归档复用不变。
该封装的普通账户单次准备随后失败，新源码目录未创建。有限双归档核对确认独立测试副本
SHA 不符，主介质原件符合固定 SHA，两者大小均为 89,036,800 字节且读取前后元数据稳定。
保留失败副本，使用已校验原件建立新副本；不推断变动原因，不重跑旧入口或放宽摘要门禁。
Windows 10 本轮单个残留测试控制器的精确恢复已执行成功；原任务、父进程和全部文件保留，
三项独立后置核对通过。宏发失败诊断仅输出固定错误码与绑定源码行列，真实失败位置尚待新实跑。
宏发新封装准备和 19 项摘要通过，原生检查在新增诊断纯回归处失败，业务未启动；
正在有限核对测试夹具返回对象形状，原断言及失败现场保留。
Windows 11 从已校验原件新建的归档实际通过 writer/reopen SHA；新入口审查、三项语法和
五项实际文本读取回归通过，普通账户单次准备成功（29 项摘要、11 项语法、30 个归档成员）。
普通账户单次 25/18/37 原生纯测试与 C# 编译均通过，正在恢复临时测试设置后接续安装。
宏发诊断夹具错误已原生复现：实际返回 Hashtable，直接使用 parsed-object 键判读不符，
经真实 JSON 保存语义序列化/严格重读后通过。新 scope 只修夹具，35 项断言及实际函数保持，
已完整通过 423 项原生纯回归、19 项摘要、15 项语法和 226 个执行依赖；
接续宏发 Runtime/Functional，通用版两项与原 13 项维护证据明确引用，完整业务结果待实跑。
宏发新 scope 的单次业务执行于 2026-10-02 03:27:38 UTC 完成：Runtime 与 Functional
各 1 通过，0 失败/跳过/重试，耗时 14,693 / 87,188 ms，CLI 均退出 0、完成标记 passed。
通用版原两项计数和 13 项维护证据按固定摘要引用；本轮还原、六项保全和原环境终态已独立核对通过。
旧服务 ready、原 168 项变更及八个备份目录保留；19 源码/来源记录保持、测试控制器与 Counter 已退出。
Windows 11 临时 Developer Mode 值已删除，原键保留、值缺席，提升终端正常退出，回到普通 QA。
冷安装前再次逐文件验证全部 15,889 个公开文件通过；独立截图确认普通 Session 1，
Developer Mode 原值缺席、原键保留、提升进程已退出，尚未开始新 Runtime 安装业务。
旧失败目录保留工具随后被错误的三规则权限要求拒绝，未移动、未安装。现场与产品合同确认
Runtime 目录为 QA/SYSTEM 两条规则；新私有工具只增加严格两规则断言、替换三处调用并更换目的地 nonce，
不修改 OS ACL、嵌入 C# 或旧现场。独立审查、原生语法两项及实际断言函数 17 项回归均通过。
新工具已在普通 Session 1 单次执行成功、退出 0，完整旧失败目录保留且秘密文件元数据一致，
未读秘密内容或摘要、未删除文件或停止任务/进程。主线 Runtime `0.1.4` 冷安装已实际单次退出 0，
普通 QA 账户返回终端，状态 running，源码/manifest/迁移头 `0069_bounded_automation.sql` 均匹配，
独立截图核对通过；继续两个 Counter 和后续实际旅程。
通用 Counter 的 NSIS 已在普通 Session 1 单次退出 0，安装包摘要匹配且独立截图核对通过。
私有统计工具遗漏 Decimal 的根因已由 Windows 原生 JSON 探针确认；新封装只补小数耗时与
显示比例两处类型分支，原门禁保持，独立审查及九项原生摘要、八项语法、48 项实际函数回归通过。
九文件只读 ISO 已双端回读匹配，Windows 11 正在接续准备；业务旅程尚未因工具修正而计为通过。
只读安装版打印枚举工具已绑定主线五份软件摘要，独立审查与 16 项回归通过，实际原生打印链仍待执行。
固定队列观察工具的三项 Windows 原生语法和 134 项实际函数内存回归通过，未执行顶层或真实 capture；
严格状态/任务关联、未完成任务禁读摘要和初始化有限失败均有回归，实际软件打印链仍待执行。
Windows 11 Spooler Running、目标驱动尚未注册；只读 DriverStore 调查找到唯一固定 Microsoft
文本驱动 INF，原大小/SHA/模型字符串及 CAT Valid/Microsoft 签名通过，尚未创建队列或打印。
主线文档 PR #226 已普通合入 `b6e6d7f824a00cd009ef8f0de2f5df1691fdd9a0`，ADR-71 正式暂停云平台。
新增两次提交仅改四份路线文档；`apps`、`packages`、`tools` 的 Git 子树与已构建 `8284470` 完全相同，
本轮继续使用该精确构建及其原验收证据，不将文档变更记成重新构建。
Windows 11 宏发 Counter NSIS 已单次退出 0，安装包摘要与普通 Session 1 独立截图匹配。
原统计纯测试的独立 `-File` 运行失败，实际定位为旧动态模块默认导出覆盖当前函数；
新 v2 仅禁止旧模块导出并增加四项实际函数来源断言，原 48 案例与六业务 helper 保持。
独立审查及 Windows 10 四项摘要、三项语法、`-File`/嵌套两种各 48 回归通过。
首次嵌套检查因父进程 Restricted policy 被拒绝；失败保留，仅为新进程设置 Bypass 后实际通过，
未更改系统策略。新两叶只读介质已全字节核对并送达 Windows 11，接续单次验收。
固定软件队列的准备工具通过独立审查、Windows 五项摘要、三项语法及 27 项实际 ACL 函数内存回归；
未执行准备顶层、原生 ACL 写入或打印。实际 CAT 为 12,996 字节的普通非 reparse 文件，
与此前有效微软签名证据一致；队列和驱动注册仍待核心业务完成后执行。
Windows 11 新 v2 统计脚本已实际单次 `-File` 退出 0、48 项通过，追加的两叶 writer/reopen SHA
与语法检查通过；独立截图已核对。随后第一项 runtime 旅程在 Windows 11 系统门禁被拒绝，
串行执行停止，尚未创建执行锁或启动 Node/柜台业务。实际 CIM 返回 `OSArchitecture="64 位"`，
Build `26300` 与两个原生 64 位布尔值均有效；私有入口错误地只接受英文字段。
正在新增旁置入口以原生 OS/进程布尔检查替换语言相关条件，原版本门禁及旧现场保持。
打印入口独审发现旧 Node/介质来源、未知状态管道提前关闭及回执 status 类型遗漏；
前者已限定到测试 Node 和来源说明，128 份安装文件与当前介质完全一致。
status 空/单元素/重复数组误接受已在 Windows 实际函数三例复现，未启动产品。
新入口修正尚未绑定或执行，软件打印门禁继续待测，不使用旧候选结果宣称通过。

---

# 上轮接续：Windows 安装版与无源码 Runtime 实机验收（2026-10-01）

- [x] 核对主线、最新 Windows Runtime CI 与目标电脑；保留 Windows 旧仓库的已有修改。
- [x] 在独立 checkout 构建干净主线 Counter，完成 inspect、用户级安装及安装后 EXE/SPA 摘要核对。
- [x] 定位并修复 Runtime launcher 清理当前进程 execution policy 导致首次安装失败；形成明确标记
      uncommitted 的本地 QA payload，完整 inspect 与无源码加载 smoke 通过。
- [x] 完成 companion 私有凭据测试入口与 launcher 修复的相关专项回归及 Edge-agent 完整类型检查；
      本地 80 项为 75 通过/5 Windows 跳过；Windows 完整相关 80 项为
      79 通过/1 POSIX 跳过，均 0 失败。
- [x] 完成 launcher 与凭据变更的 lint、Prettier、SPA verify/build/typecheck 与 Edge-agent 完整测试；
      Edge-agent 共 513 项全部通过，lint 为 0 warnings。
- [x] 修复提升权限 SSH 注册任务后绑定用户仅有读取权限、导致 Session 1 Limited 启动失败的问题；
      对严格匹配的本任务设置精确私有 ACL，保持 Limited，独立安全审查及合成 ACL 回归通过，
      最新 QA manifest 已绑定，真实 Task owner/Protected/三条 ACE/Limited 已核对。
- [x] 自带任务在 Session 1 启动常驻服务，退出码 0；health ready，Node/PostgreSQL 均在 Session 1，
      独立 SSH 复查保持 ready；OS 重启与重新登录恢复仍为后续独立门禁。
- [x] 安装版 Runtime E2E 在真实 Session 1 通过，覆盖打包身份、DPAPI、固定 origin、renderer 权限、
      登录、关闭/重开恢复与退出；1/1、11.4 秒，实机截图本地目视正常。
- [x] 功能 E2E 保留全部 viewport 断言复跑通过：1/1、约 1.1 分钟，十导航、账户/复核、合成业务主链与重开；
      Session 1 非提升令牌，renderer/server 错误均 0，DPR=1.5、viewport 946×658、无横向滚动，
      六张截图保存并目视工作台/已结清状态正常；长表单允许正常纵滚。
- [x] Runtime installed status、受控启停/repair、任务启动与托管 backup/list/verify 通过；错误确认
      被拒且数据不变，原备份已恢复合成两行基线且后建表不存在。
- [x] 安全点恢复至三行且后建表存在，最终再次恢复原备份两行且后建表消失；完整十场景报告为
      status=passed、10/10 PASS，四份托管备份保留，验证结束服务 ready。
- [x] 受控停止 QA 并保留数据库/四份备份，companion 任务禁用、自建手动 QA 任务移除；
      原 development 任务及 Session 1 服务恢复 ready，原 handoff 摘要与旧仓库 SHA 保持，独立 SSH 最终复查通过。
- [x] 回写验收结果、计划与下一步门禁；本轮未提交、推送、合并或删除分支。

基线为干净 `main = 83d8044e56107e2b723bf652702e6f0c76dfe7b3`（PR #222）；
CI run `36691826087` 已通过 Runtime 20 个软件场景。本地 QA 使用合法标识 `0.1.0-win-dev.2026100102`，
外部构建记录明确 `artifact_kind=local_qa_not_release`、`source_tree=uncommitted`；
仅包含 launcher、host 修复与 release 标识变化，不能称为 exact main、修复版 CI 或正式发行。
新鲜实机证据与后续独立门禁见[本轮接续记录](docs/operations/2026-10-01-windows-installed-runtime-localqa.md)。

本轮只使用合成数据。现有开发 Runtime 与 companion 分目录但共享固定端口，切换前识别任务与进程，
通过原有受控停止入口保留旧数据。CI 故障注入矩阵不直接运行到已有实例。

本轮之后按顺序推进：两项安装修复的对应 SHA CI（未获 Git 授权前不提交）→ Windows 11、OS 重启/
重新登录、中文 IME → XP-58 实体打印、签名/内部分发裁决与目标机第二版本升级回滚 → ADR-65
生产准入。安装版测试的懒路由等待修正属于测试竞态，不记为产品缺陷。

---

# 当前任务：活动 V2 Windows 定制桌面 EXE 与宏发受控实操（2026-08-30）

> **本文件已纳入版本控制，且仓库是公开的。** 写入前自查：不得出现密钥、口令、PIN、release
> token、真实顾客 PII，也不得记录主机上凭据文件的具体路径或变量名（这类定位信息发到公开
> 仓库等于给出半张地图）。运维私有细节留在主机侧记录，本文只写判据、结论与可复核的标识。

## 目标与裁决

- 主交付线改为活动 V2 的 Windows x64 桌面 EXE，面向宏发门店受控实操；根 `src/` 的历史 V1
  Electron 不复活、不作为交付入口。
- ADR-66 已接受：Windows 安全持久化、用户级密钥保护、打印执行器、NSIS 打包和桌面验收均须
  保持既有崩溃安全与密钥保护不变量。
- 浏览器/Edge 只可辅助排查，不能作为 Windows 桌面发行验收；权威证据来自打包后的 Electron
  应用、真实 Windows 运行环境和实体打印/运营记录。
- Gitea 不同步、不清理、不作为本轮交付依赖；Windows 代码传输可走受控 SSH 文件通道。

## 当前阶段

W2：无源码 companion 生命周期与本机托管备份恢复已进入 main，并通过 Windows CI 软件场景；
Windows 10 的本地 QA 安装版与维护 smoke 已完成，两项安装修复仍待对应 SHA CI。
继续完成 Windows 11、OS 重启/重新登录、中文 IME、签名、实体打印与生产准入。W0 已关闭，W1 的历史验收
只代表桌面壳、打印软件链和 NSIS；本轮实机接续以顶部 2026-10-01 记录为准。

## 阶段清单

### W0：安全与崩溃一致性基线

- [x] 修复跨 shell 包脚本，证明 Windows 能发现并运行既有测试。
- [x] 接受 ADR-66，冻结 Windows durable replace、目录 flush、私有 ACL 与 DPAPI 边界。
- [x] 完成 `@laundry/platform-fs` 的 Windows helper、摘要校验、目录/文件私有 ACL 和回归。
- [x] 将 Edge/Server 的文件存储、队列、身份、信任、升级、照片与打印 spool 迁移到共享原语。
- [x] 在 Windows 10 重跑相关 Edge/Server 测试并关闭平台差异失败。
- **状态：** completed（Edge 404 项 0 fail；Server 1167 项 0 fail）

### W1：Windows 打印与发行包

- [x] 将签名派发 executor 接入 Windows RAW spooler；保留既有 `usb-port.ts` 直连作为受控退路。
- [x] 为活动 V2 Electron 增加 Windows x64 NSIS 打包，不调用冻结的根 V1 `build:win`。
- [x] 将原生 helper 作为受摘要约束的 unpacked 资源打包并从发行路径解析。
- [x] 产出明确标记未签名/development-only 的安装包、摘要清单和安装/修复安装/卸载回归；真正
      跨版本升级/回滚在形成第二个版本后于 W2 独立验证。
- **状态：** completed_shell_only（安装器能启动 Electron，但尚未交付独立 localhost 业务服务）

### W1.5：Windows 本地业务服务运行链

- [x] 复现用户启动安装版后报错，并证明 Electron 未崩溃、8787 无监听、与 Clash 无关。
- [x] 盘点 Fastify/PostgreSQL 的既有启动、迁移、秘密文件和平台前置条件，冻结不降低安全边界的
      Windows 部署拓扑。
- [x] 实现独立于 Electron 的 Windows development 本地服务安装/启动/停止/健康检查；Electron 仍只连接固定
      `127.0.0.1:8787`，不内嵌数据库或把业务逻辑搬入主进程。
- [x] 使用合成数据验证首次初始化、重复启动、失败诊断和登录会话 Electron 进入可用页面。
- [x] 以禁止 hard terminate 的登录任务和 Server→`pg_ctl fast` stopper 验证停止/启动恢复，并用真实
      安装版 EXE 完成登录、重启会话恢复和桌面截图。
- [x] 在同版本重复安装上验证安全停机、迁移/引导/校验、任务重注册与 ready 恢复；安装器等待直接
      `pg_ctl` 而不等待后台 postgres 进程树。
- **状态：** completed_development_runtime（正式 no-repo companion 与安装/修复/卸载整合进入 W2）

### W2：桌面与生产准入

- [x] 对解包版与安装版 Electron 运行自动 smoke，并在真实登录会话取得目标窗口稳定错误态截图。
- [x] 在真实 Windows 登录会话验证显示、DPAPI 可用、原生 helper、加密队列与打印机枚举；浏览器
      证据未计入。
- [x] 验证真实安装版 Electron 通过真实 `/health`、使用随机生成的 development 操作员登录，并在
      关闭/重开同一 EXE 后恢复会话进入可用业务页面。
- [x] 通过安装版 Electron 创建一名独立合成测试店长并完成双人复核、私有凭据落盘、错误密码拒绝、
      密码登录、PIN 快速切换、会话重启恢复与退出。
- [x] 以该测试账号覆盖十个桌面导航面、价目、客户/档案、开单、部分收款、原路退款、欠款取衣结清、
      工作台、账目/对账、主题和打印队列，并保存视觉证据。
- [x] 用只读数据库终态核对账号、价目、客户、订单、支付/退款、衣物状态和审计事件，清理临时 runner；
      XP-58 实体出纸、真实 provider、不可逆隐私删除和真实数据不计入本轮通过。
- [x] 将固定 Node、Server、migration 与 PostgreSQL payload 制成不依赖源码仓库的 Runtime companion，
      安装、修复、升级/回滚、启停、保留数据卸载及托管备份恢复已进入 main；PR #222 对应 Windows CI
      run `36691826087` 的 20 个软件场景通过。
- [x] 在 Windows 10 真实 Session 1 完成无源码 companion 与安装版 Counter 的本地 QA：
      两项 E2E、150% DPI 与十场景生命周期/托管恢复 smoke 通过，原开发服务已恢复；
      2026-10-01 的未提交 QA 修复与主线 CI 独立记录，不构成正式发行。
- [ ] 完成两项安装修复的对应 SHA CI、Windows 11、OS 重启/重新登录及中文 IME 独立验收。
- [ ] 接入宏发目标 XP-58，完成 RAW 出纸、中文、金额、条码、走纸、切刀、断连、补打与防重复实证。
- [ ] 取得 Authenticode/受控内网安装裁决，并以第二个版本完成跨版本升级与回滚。
- [ ] 关闭 ADR-65 的生产候选、离机恢复、告警、容量与迁移安全门禁后，才允许真实顾客数据。
- **状态：** functional_journey_completed_development_only（实体硬件、签名与生产准入仍待外部条件）

### W3：宏发受控实操

- [ ] 冻结宏发发行 profile、设备/打印配置、回滚点与操作手册；不在核心业务代码创建客户分叉。
- [ ] 先用合成数据完成门店演练，再在 W2 准入后进入限范围真实运营。
- [ ] 记录故障、恢复、打印成功率和人工回退证据，未取得现场证据前不称正式交付完成。
- **状态：** pending_after_W2

## 完成条件

1. Windows 10 上相关测试、类型检查、构建与打包均为新鲜绿灯。
2. 安装后的活动 V2 Electron 可以启动、显示、连接受控服务并完成桌面级验收。
3. 实体打印与失败回退有现场证据，私有文件/密钥和崩溃一致性不变量未削弱。
4. 生产数据准入与宏发交接分别有独立证据；开发包、模拟数据或浏览器页面不能替代。

---

# 历史任务：依次关闭 Stage 5.0、实现 Stage 5.1、提交推送并部署（2026-08-23）

## 目标

严格按 ADR-64 顺序先关闭 5.0 发布留存阻塞，再用独立 ADR/实施计划承接 5.1 Cloud 生产基线；
所有代码与文档通过相称门禁、独立复审、受保护 GitHub 主线 CI 后，部署精确 `main` 并回写证据。

## 当前基线与授权

- 本地干净 `main = origin/main = b9ddacc9ae85551ce6b66f7da9f1dd7811d3e6ca`；精确 SHA 的
  `workspace-check`、`real-postgres`、`runtime-app-macos` 均成功。
- 用户已明确授权按推荐顺序实现、测试、提交、推送和部署。
- 远端归档仍遵守 ADR-64 的精确对象门禁：先新鲜只读列出，再对精确对象执行可恢复 rename；
  不复用 2026-08-20 的候选快照，不自动选择“最老”。
- 5.1 关闭前 hk-vps 继续只使用合成数据，不输入真实顾客 PII，也不称生产 SaaS。

## 当前阶段

阶段 2：Stage 5.0 发布后可持续留存收口（Claude 2026-08-27 只读复核：live 已是 `c8919af`，回写在 PR #209 待合）

## 本轮阶段

### 阶段 0：新鲜基线与只读盘点

- [x] 刷新 GitHub `main`、精确 SHA checks、开放 PR/Issue 与工作树
- [x] 核对 hk-vps 指纹、SSH authority、主机健康和 release status
- [x] 用 exact-main 维护树新鲜执行 inventory、artifact lists 与 release-set list
- [x] 将精确候选、计数、风险和所需授权记录到 findings/progress
- **状态：** completed

### 阶段 1：Stage 5.0 留存解阻

- [x] 对精确 superseded rollback 执行受控退役并验证 same-inode/反向可恢复性
- [x] 新鲜复列后对精确完整 release set 执行 manifest-bound 归档
- [x] 复核 active 四类绑定、磁盘、systemd、loopback/公网健康
- [x] 运行 retention preflight 并证明所有留存门禁解除
- **状态：** completed

### 阶段 2：Stage 5.0 精确发布与回写

- [x] 将 `b9ddacc` 正式发布为 hk-vps live
- [ ] 用 live runner 重跑 inventory/list/preflight 与 API/Browser 验收
- [ ] 回写 Stage 5.0 发布结果、README、CHANGELOG、计划检查表和运维文档
- [ ] 提交/推送/PR/required CI，并复核精确 merge SHA 的 push CI
- **状态：** in_progress_post_deploy_retention_full_waiting_exact_object_authorization

> **Claude 2026-08-27 只读复核（不代 Codex 勾选，仅记录实测）**
>
> - live marker 已不是 `b9ddacc` 而是 **`c8919af3c666cf70df2fbf04645ebdf0f377f35a`**，其 history
>   记录 `outcome=committed`、`authoritative=true`、`same_migration`、head `0069`，创建于
>   `2026-08-25T08:32:40.437Z`。`authoritative=true` 意味着该轮的 API/Browser 验收已由 finalize
>   亲自跑过，即上表第 2 项在 `c8919af` 上已有证据。
> - 第 3、4 项对应的回写已存在于 **open PR #209**（关闭 Stage 5.0、启动 5.1，含 ADR-65、
>   `docs/operations/2026-08-25-stage50-release-result.md` 与 5.1 计划），**尚未合入**，
>   因此这两项在 `main` 上仍未闭环。
> - 留存四类实测：history 7、controller 7、backup 7 对、`/opt` 常驻 5；峰值 `5+2=7 < 8`，
>   Stage 5.0 的解阻目标已达成。
> - Claude 8-15 开的 #203/#204 已于 8-27 关闭（被 `198b0d0` 取代，非合并）；两分支保留未删。

### 阶段 3：Stage 5.1 Cloud 生产基线

- [ ] 新增并签署 Stage 5.1 独立 ADR、差距矩阵和实施计划
- [ ] 冻结生产/测试环境、身份、秘密、容量、告警与恢复边界
- [ ] 复用并补齐 ADR-43 data-protection systemd、真实 offsite authority 与告警接线
- [ ] 完成本机备份、离机复制、影子演练、联合恢复和事故回滚的真实证据
- [ ] 保持真实 PII 禁令，直到所有关闭证据齐备
- **状态：** pending_after_stage_5_0

### 阶段 4：最终门禁、交付与精确部署

- [ ] 运行 focused、workspace、真实 PostgreSQL、Browser 与相称安全/数据库/TS 复审
- [ ] 按行为边界拆分提交，推送交付分支并通过 required CI
- [ ] 合入受保护 `main`，复核精确 merge SHA push CI
- [ ] 部署精确 `main`，完成现场复核和无秘密结果回写
- **状态：** pending

## 关键停止条件

1. 指纹、身份、transition、对象绑定、摘要、owner/mode、容量或 CI 任一漂移即失败关闭。
2. 精确归档对象尚未新鲜列出或未获得对象级授权时，不执行 rename/archive。
3. 未确定真实 offsite failure domain、authority、告警接收端或恢复数据损失窗口时，5.1 保持
   `blocked_external_offsite` / `blocked_external_alerting`，不得伪造完成。

---

# 历史当前任务：把 `c04f858` 发布到 hk-vps 并收口交接（2026-08-15）

## 交接背景

Codex 会话已于 2026-08-15 12:00 前后退出，最后一次动作是合入 PR #201 并在 12:00:12 对无主
产物执行归档。用户明确要求由 Claude 接手，把剩余事项「统一做完」，并在被告知实际阻塞后
明确授权归档 `53b012c…ba64d6d3` 以腾出 history 槽位、完整执行发布。

本文件与 `progress.md`、`findings.md` 在接手时停在 2026-08-13 22:5x，落后两天；下列内容按
真实仓库与 hk-vps 状态重新校准。

## 接手时的真实基线

- `main = origin/main = c04f858362f1a02bf857b668513a1d1e29f64104`，工作树 0 变更，0 open PR；
  该 SHA 的 V2 Foundation 与 V2 PostgreSQL Integration 两套 push CI 均 success。
- hk-vps 线上 marker 仍是 `b80ab3e1af8145f7c49b6767a87dcbf89079e1ec`（2026-08-14 那轮），
  迁移头 `0069_bounded_automation.sql`，库内账本 69 条，四个 systemd unit active，
  Desk loopback/公网与 KB loopback/公网 health 均正常，无活动 transition。
- 未发布差量只有 PR #200（无主发布产物受控归档路径）与 PR #201（修复 `measureTree` 拒绝
  符号链接导致无法归档任何真实产物）；本轮无迁移变更，`0069 → 0069`。

## 发布前置逐条核对结论

2026-08-14 发布结果 §8 只记录了 `/opt` 产物上限，这不完整。真实阻塞是 **history 计数**：
`assertRoomForRelease` 在 `count >= MAX_RETAINED_RELEASES(8)` 时失败关闭，而 history 恰为 8。
`/opt` 侧的 `laundry-desk.` 前缀产物只有 5（live 不带点、不计数），并不阻塞。

| 前置                      | 实测                                           | 判定                                             |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| 候选 = HEAD = origin/main | `c04f858…4104`                                 | 通过                                             |
| 工作树（含 untracked）    | 0 变更                                         | 通过                                             |
| 精确 SHA 主干 CI          | Foundation + PostgreSQL Integration 双 success | 通过                                             |
| live marker               | `b80ab3e…9e1ec`                                | 通过                                             |
| 迁移                      | 候选 69 条 / head `0069`，库内 69 条           | 通过（`same_migration`）                         |
| transition                | 不存在                                         | 通过（stable）                                   |
| `/opt` `laundry-desk.*`   | 5                                              | 通过                                             |
| backup                    | 7 对                                           | 通过                                             |
| verification evidence     | 5                                              | 通过                                             |
| history                   | **8**                                          | **阻塞** `CLOUD_RELEASE_HISTORY_RETENTION_LIMIT` |

## 本轮步骤

- [x] 重新校准真实基线，纠正「阻塞已解除」的错误判断
- [x] 经用户明确授权归档 `53b012c…ba64d6d3`（`outcome=rolled_back`、`phase=staged`、
      `authoritative=false`、`backup=null`、`evidence=null`、`write_gate=null`）及其绑定
      controller，history/controller `8/8 → 7/7`，剩余仍严格 1:1，未删除任何东西
- [x] 单进程两阶段发布 `c04f858`：第三次尝试提交成功，API 20/20、Chromium PASS、
      `authoritative=true`；前两次分别以 `PUBLIC_HEALTH_FAILED`（自动回滚，线上无损）与
      `ARTIFACT_RETENTION_LIMIT`（预检挡下）失败关闭
- [x] 发布后独立只读复核，回写发布结果文档、README、CHANGELOG、运维手册与交付计划状态
      （docs-only PR #202）
- [x] 清理本地残留：删除 `/private/tmp` 下 167 项 `laundry-*`（含 36 个 bootstrap 密码/PIN
      文件与 4 份存有 release token 的 `prepare.stdout`），移除 4 个遗留容器；命名卷保留
- [ ] 等 PR #202 required CI 绿灯并合入，复核精确 merge SHA 的主干 push CI

## 遗留给下一轮

1. **公网 health 探针无重试**（建议单独 PR）：`assertDeskHealth` 里 loopback 有
   `awaitDeskReadiness` 就绪重试而公网只有 `curl --fail --max-time 15` 单发。一次十几秒的
   hairpin 抖动就能作废一整轮已完成停写、备份、影子恢复与迁移的发布窗口，代价是四个留存
   集合各消耗一格。
2. **留存槽位再次到顶**：history 8、controller 8、backup 8 对、`/opt` 常驻 6。下一次
   `prepare` 会先以 `CLOUD_RELEASE_ARTIFACT_RETENTION_LIMIT` 失败关闭，需先经明确授权腾槽位。
   `/opt` 那一格现在可以走已上线的 `--archive`；history/controller/backup 仍无工具。
3. **history/controller/backup 归档缺工具**：目前三类证据的退役只能手工守卫式搬迁，
   建议按本轮实际用过的守卫顺序沉淀成一个受控子命令。

## 归档动作留痕

- 目标：`/var/lib/laundry-desk-release-archive/53b012c62ae0956ca58ef4cc1b8f46091c97d5b9-ba64d6d3-rolled-back-retention/`
- 方式：同文件系统原子 rename，`history ino=1115533`、`controller ino=2032138` 移动前后一致；
  反向 rename 即可完整还原，不删除任何证据。
- 选择理由：三条 `rolled_back` 中只有它 `backup_path=null`，退役后不会留下 orphan backup；
  另两条各自绑定 backup dump，退役需连 backup 一起搬，动的面更大。

---

# 历史当前任务：逐项交付 Stage 4.4/4.5 的 18 项，最后统一发布

## 当前授权与固定顺序（2026-08-13 更新）

1. hk-vps 保持已恢复且健康的 `f276bdb…fdca / 0048` 基线；失败的 0053 数据库与发布证据
   继续隔离保留，不再单独发布 0053，也不按功能逐项发布；
2. 先完成 Stage 4.4 的 11 项与 Stage 4.5 的 7 项；依赖内保持顺序，每项独立提交，互不依赖的
   delivery、marketing/self-service 与 AI 切片可并行；
3. 每一项能力独立形成一个行为完整、可回归的 commit，不把多项功能揉成一个提交；
4. 全部完成后运行 workspace、真实 PostgreSQL、Browser、相称安全/数据库/TypeScript 复审；
5. 推送交付分支；只有精确主线 SHA 的 required/push CI 成功后，才处理 retention 上限并将
   0048→最终迁移头一次性发布到 hk-vps。

用户已授权本轮所需的可恢复 retention 归档、commit、push、merge 与最终 hk-vps 发布，并明确
后续按既定计划自动执行、不再逐项询问；没有把真实 provider、真实顾客 PII、实体硬件或正式
桌面发行证据包含进来。所有合并仍经受保护主线 PR/required CI，不绕过保护。

2026-08-13 后续节奏调整：用户要求减少一轮又一轮的细粒度复审、优先快速完成 18 项。每项改为
实现者自查 + 一轮聚焦测试/类型/lint/build；已经发现的高风险阻断必须修，但不再为同一修复反复
启动独立 reviewer。只在出现新的安全问题、最终统一集成或准备发布时做一次相称终审。

## 当前阻塞修复

用户于首次 0053 发布 fail-stop 后明确要求继续，并指定使用多 Agent 完成。当前并行边界为：
delivery、marketing/self-service 与 AI 依赖链可并行；每项仍保持一个独立 commit。候选提交已形成
`16/18`（Items 1–12，以及 Items 14、16–18）。Item 10 的 Caddy 真正路由绑定、logout
吊销、merge direct DML、duplicate-tab authority、OpenAPI 副作用及 named-route 控制流缺口均已
关闭，最终单提交为 exact `ce253c2`。按用户最新节奏不再对同一修复反复启动 reviewer。新集成分支
`codex/stage44-45-integration-v2` 已从 `main@27f0a7a` 串入 Items 1–4；0054→0057 的逐项
catalog golden 已保留，Item 4 等价集成提交为 `00b62f1`；此前 0054→0056 fresh PG、目录
治理、写冻结与数据保护均绿；Item 5 纯 Web 增量已串为 `e054c7e`，集成 Web typecheck 通过。
Item 4 的 fresh PG/workspace 已绿，step-up 取消竞态已修复并经
独立终审 APPROVE，形成严格单提交 `58bb10e`；Item 5 已形成单提交 `3791cb7` 并等价串入集成分支。
Item 9 的
最后一项团购 replay-authority blocker 已修复并经原审查者 APPROVE，已形成唯一提交
`cc30ca0`；Item 7 的 R4 PIN 取消竞态、预算账本 app-role 写权限、营销专用 HTTP 限流与
pending 幂等唯一性四项缺口均已关闭，形成单提交 `1111f73`。
Item 6 已完成 0058 与现场证据闭环，独立 8558 真库和最终门禁全绿；Item 16 已完成 0068
异步审批中心与独立真库。Stage 4.4 的 0054–0063 已在集成分支以 merge commit `d57ed09`
汇合，工作树干净并保留各项独立提交历史；Item 18 已以单提交 `f930821` 完成并串入统一分支
`1d50d56`；Item 16/17 已分别等价串入统一分支 `3c0f4e4` / `1f84451`。用户明确暂不创建
OpenAI key，故 Item 13/15 曾先后置。用户现已明确授权复用 hk-vps Hermes 的既有 DeepSeek
测试凭据：Item 13/15 恢复实施；DeepSeek 做真实连接验收，Anthropic/Gemini 在无对应凭据时只做
协议夹具、错误归一化与失败关闭门禁，不虚报真实连通。全部 18 项完成后再统一部署。

- [x] 归档最旧的 `629bc9c…f1a1` rolled-back history/controller，活动集合 `8/8 → 7/7`；
- [x] 归档 `a832bbd…be01` failed tree，活动 `/opt` 制品 `6 → 5`，全量 release preflight 通过；
- [x] 重跑 `prepare` 并确认失败后远端自动恢复到 `stable / f276bdb / 0048`；
- [x] 定位首因：新增 `tools/cloud/systemd/` 目录被 controller installer 当作普通文件读取；
- [x] 递归、失败关闭地冻结 controller 文件树，统一全局 inventory 顺序并补嵌套/前缀碰撞回归；
- [x] 独立 commit `3272182`、push、PR #173 与 required CI 全绿；
- [x] 合入 PR #173 为 `main@02b3883b…0d4b`；
- [x] `main@02b3883b…0d4b` 的 push CI 全绿（Foundation 与真实 PostgreSQL/Playwright）；
- [x] 初次 `prepare` 返回 `CLOUD_RELEASE_REMOTE_DEPLOY_FAILED` 后只读取证，确认 transition 前的
      bootstrap 裸 shell 失败缺少稳定阶段码，且旧 cleanup 会误删碰撞 staging；
- [x] 修复已增加 archive/digest/staging/extract/entry/cleanup 稳定码、对象身份绑定清理、严格有界
      stderr 透传与独立 shell 回归；focused 20/20、cloud 281+1 skip、`workspace:check` exit 0；
- [x] hk-vps 恢复为 `stable / f276bdb / 0048`，两个失败 0053 数据库均
      `ALLOW_CONNECTIONS=false`，代码、历史、controller 与 backup 证据保留；
- [x] 建立 `codex/stage44-45-integration-v2`，从 exact `main@27f0a7a` 串入 Items 1–3；
- [ ] 完成 Items 1–18、逐项复审、统一集成门禁与 PR/required CI；
- [ ] 最终发布前归档完整 4d331 rolled-back 证据包释放 retention 槽位，再一次性发布。

## 18 项独立提交清单

- [x] 1. 门店取送范围、时段、运费和可预约规则（提交、真实 PG 与独立安全终审通过）
- [x] 2. 顾客取送预约、改期与取消（提交、真实 PG 与独立安全终审通过）
- [x] 3. `delivery_order` 权威订单及完整状态机（单提交、真库、Web 竞态与独立终审通过）
- [x] 4. 配送任务分派、接单、转派和人工接管（单提交、真库、全量门禁与独立终审通过）
- [x] 5. 配送员/员工移动 H5 任务面（单提交 `3791cb7`，Web 完整门禁绿）
- [x] 6. 取件、送达、异常、照片、签名、GPS 等交付证据（单提交 `4cd26eb`，独立真库与门禁绿）
- [x] 7. 营销活动定义、受众筛选、时间窗和预算上限（四项阻断已修，单提交 `1111f73`）
- [x] 8. 批量发券、活动资格和核销冲正（单提交、真库并发证据与独立终审通过）
- [x] 9. 推荐奖励、团购核销等营销扩展（单提交、真库与两轮独立安全终审通过）
- [x] 10. 顾客自助查询订单、票据和件级洗护进度（单提交 `ce253c2`）
- [x] 11. 顾客自助钱包、次卡、积分、券包、地址与通知偏好（单提交 `c6eae55`，fresh PG 0001→0062）
- [x] 12. BYOK 加密存储、轮换、吊销与模型注册表（DB authority 加固后单提交 `0a0ee50`）
- [ ] 13. OpenAI-compatible、Anthropic、Gemini adapters 与连接验证（实施中；DeepSeek 真实验收）
- [x] 14. 流式 AI 会话、SSE 和有界 tool-use 循环（单提交 `b729cc3`，真实 PG、focused 门禁绿）
- [ ] 15. 经营问答、订单/顾客检索、规程排障等只读助手（实施中；补 0067）
- [x] 16. R3/R4 确认卡、另一管理员复核及异步审批中心（单提交 `83d45f6`，真库与聚焦门禁绿）
- [x] 17. 有界自动化策略、调度、暂停和额度控制（单提交 `52c0552`，集成等价 `1f84451`）
- [x] 18. Token/成本、熔断、PII 脱敏、SSRF、Prompt Injection 红队和失败降级（`f930821`）

---

# 历史当前任务：ADR-37 后续 1→5 顺序实现

## 目标

以云服务器部署的 Linux Web Server 为当前主产品形态，严格按以下 1→5 顺序实现并验证：

1. Owner 公网经营与授权门店管理；
2. 会员等级、积分、次卡、优惠券与有效期；
3. 顾客扩展档案与政策；
4. 大型云端模块；
5. 桌面、硬件与真实迁移等后置独立门禁。

实现顺序以本地设计、代码、真实 PostgreSQL、Browser 与 workspace 总门禁为阶段切换条件；
GitHub CI、精确 SHA 云端证据和外部硬件/provider 验收保持独立交付层。未获提交或发布授权时，
可以继续下一阶段的软件实现，但不得把上一阶段标成已发布或用模拟证据冒充外部闭环。

## 当前阶段

阶段 3.2 至 4.5 已全部交付并完成云端发布。PR #171–#181 依次合入受保护 `main`；精确 merge SHA
`65bd8210c824037d4c871a46ce3eaf3e3dc1c314` 的 V2 Foundation `#31705863621` 与 V2 PostgreSQL
Integration `#31705863502` 双绿，并已两阶段发布到 hk-vps，迁移由 48/head `0048_catalog_governance.sql`
推进到 69/head `0069_bounded_automation.sql`。公网 API 19/19 journey PASS、Cloud Chromium PASS，
`verification_evidence_authoritative=true`。

首个候选 `53b012c62ae0956ca58ef4cc1b8f46091c97d5b9` 的两次尝试均失败关闭并回滚（第一次终止于
`staged`，第二次已过写门闩与迁移后终止于 `recovery_required`，两次 `verification_evidence_authoritative`
均为 false）；PR #179–#181 修复发布验收侧缺陷后才以新候选重新发布。

本轮 `old_code_compatible=false`、`compatibility_decision=unproven`：跨 21 条迁移，旧代码未被证明
可在 0069 schema 上运行，回滚必须走保留的 controller 与 pre-release dump，不能只切换 `/opt` 目录。
`/opt` 现有 7 个产物（1 live + 1 failed-`53b012c` + 5 rollback），接近阶段 3.1 触发过的保留上限，
下次发布前应按明确授权先对失败产物做可恢复归档。

Stage 4.2 的真实短信/微信与 Stage 4.5 的真实 AI provider 仍因缺少凭据、模板审批、额度和 callback
授权而保持 `software_only` / `blocked_external_provider`，不声称已发送、已送达或已产生真实模型调用。
外部 provider、桌面发行、实体硬件和 v1 真实数据迁移继续保持独立门禁。

发布结果已回写仓库：新增 `docs/operations/2026-08-13-stage32-45-release-result.md`，并同步
README、`docs/CHANGELOG.md` 与 Cloud Web-first 交付计划的阶段状态。

## 当前顺序阶段

### 阶段 0：云端 Web 真源与缺口审计

- [x] 刷新 `origin/main`、GitHub PR/CI 与工作树边界
- [x] 对照 ADR-36、活动产品设计、后续计划与验收记录
- [x] 对照 Contracts、Server、Web UI、真实 PostgreSQL 与 cloud harness
- [x] 把缺口分成未开发、已开发未接 UI、已开发未做公网 UI 验收、外部依赖四类
- [x] 冻结云端优先 backlog、依赖关系与验收口径
- **状态：** completed

### 阶段 1：云端部署与 Web 验收基线

- [x] 新 ADR 固化 Cloud Web-first，订正 README、CHANGELOG、后续计划与验收真源
- [x] 将候选 `7989206b3e9748b2a607687466ef2e0775ad528e` 可重复部署到 hk-vps
- [x] 应用 migration 0046，验证 marker、TLS、SPA、health、双管理员、认证与 RLS
- [x] 实跑可审计可清理的 30/90/180 天催取 fixture
- [x] 实跑只读公网 `core_ui_subset`，保持 Browser/API 证据分层
- [x] 完成两阶段发布、恢复点、联合回滚、权威 evidence 与 KB health 判据
- [x] API 15/15、Cloud Chromium PASS；GitHub milestone #7 与 #145–#152 关闭
- **状态：** completed（2026-08-11）

### 阶段 2：剩余核心店务功能

- [x] 2.0 刷新 Contracts、DB、Server、Web 与现有 E2E，冻结三个切片的精确缺口与 ADR-38
- [x] 2.1 计价权威：设置读回与真实生效、服务端附加费/急件/运费、受控折扣与审计
- [x] 2.1 完成契约/DB/Server/Web、真实 PG 与 Browser 定向回归，并记录 checkpoint
- [x] 2.2 支付流水查询与 `payment.refund` Web 双人复核闭环
- [x] 2.2 完成契约/DB/Server/Web、真实 PG 与 Browser 定向回归，并记录 checkpoint
- [x] 2.3 衣物颜色/品牌 Web 输入、瑕疵/附件/件级备注与跨刷新挂单召回
- [x] 2.3 完成契约/DB/Server/Web、真实 PG 与 Browser 定向回归，并记录 checkpoint
- [x] 集成运行 workspace、完整真实 PostgreSQL 与 Browser/packaged 相称门禁
- [x] 执行 TypeScript、数据库、安全与 silent-failure 提交前终审并关闭阻断项
- [x] 分组提交、推送、PR、required CI、合入并等待精确 merge SHA 主干 CI
- [x] 只用合成数据将最终 merge SHA 两阶段发布到 hk-vps，完成 API/Browser/DB/审计/清理验收
- [x] 回写仓库、GitHub tracker 与 KB，明确阶段 2 完成或精确 blocker
- **状态：** completed（PR #167；部署 `6f106076018940eec8fcc9e8c2cfb7842c323f47`）

### 阶段 3：第二批产品增强

- [x] 3.1 冻结价目排序、停用项恢复与安全审计的 ADR-39、权限和迁移边界
- [x] 3.1 完成 Contracts、0048、Server、Web、Cloud harness 与合成验收接线
- [x] 3.1 完成定向、完整真实 PostgreSQL、Chromium 17/17 与 workspace 总门禁
- [x] 3.1 独立复审、PR #169、required CI、合入与精确 merge SHA 主线 CI
- [x] 3.1 部署 `f276bdb…fdca`，完成 API/Browser/catalog/marker/health/清理验收及 PR #170 回写
- [x] 3.2 审计既有 ADR-26/27 Owner Dashboard、明细、组织内授权门店组合和 LAN 假设
- [x] 3.2 新 ADR 冻结公网 Owner 身份、权限、组织/门店作用域、隐私与历史快照边界
- [x] 3.2 完成 Contracts、DB/迁移、Server、Web 与 Cloud acceptance
- [x] 3.2 完成定向、完整真实 PostgreSQL、Browser harness 与 workspace 总门禁
- [ ] 3.2 完成 PR/精确主线 CI、hk-vps 两阶段发布和公网验收
- [x] 3.3 审计 ADR-17/18/22/25、现有储值账本、会员 Web 与历史后置边界
- [x] 3.3 ADR 冻结虚拟等级、订单积分、次卡、券与有效期语义
- [x] 3.3 完成 Contracts、0050、Server、Web 与 Cloud acceptance
- [x] 3.3 完成定向、真实 PostgreSQL、Browser harness、workspace 总门禁与独立安全复核
- [x] 3.4 审计顾客/隐私、计价、会员等级、打印与上挂骨架并在安全复核后重冻结 ADR-42
- [x] 3.4 先关闭递归 merge、通用 PII 副本与匿名化后离线复活三组 P1
- [x] 3.4 完成 Contracts、0051、双后端 Server 与隐私/计价集成
- [x] 3.4 完成 Web、Cloud API/Browser 合成旅程
- [x] 3.4 完成定向、真实 PostgreSQL、Browser、workspace 与独立复核
- **状态：** software_local_complete（3.2/3.3/3.4 外部交付待授权）

### 阶段 4：后续大模块

- [x] 4.1 审计 release database-only 恢复点与 Runtime 数据保护边界，冻结 ADR-43/验收矩阵
- [x] 4.1 实现 root-only 恢复集、严格 manifest、操作状态与同一发布锁
- [x] 4.1 实现影子恢复、照片清单校验、离机复制和健康/告警判据
- [x] 4.1 实现 pre-recovery 安全点与代码/迁移/数据库/照片联合恢复
- [x] 4.1 完成定向测试、真实 PostgreSQL/照片验收、workspace 与独立复核
- [x] 4.2 审计 ADR-23/37/42、现有人工名单、权限、隐私与后台 worker 骨架并冻结 ADR-44
- [x] 4.2 完成 Contracts、0052、双后端 outbox、worker/fake provider 与回执状态机
- [x] 4.2 完成 Web capability/批次/人工降级与 Cloud API/Browser 合成旅程
- [x] 4.2 完成定向、真实 PostgreSQL、Browser、workspace 与独立复核
- [x] 4.3 店厂交接批次、清点差异、质检/返工与移动交接证据
- [ ] 4.4 取送、营销/券活动与顾客自助入口
- [ ] 4.5 AI/BYOK 权限投影、风险确认、成本上限、失败降级与密钥隔离
- [ ] 真实短信/微信/支付/AI provider 只在取得独立测试凭据后执行外部验收
- **状态：** software_local_complete（4.3；PR #171 required CI 进行中）

### 阶段 5：后置独立门禁

- [ ] Windows 打包及真实主机安装、升级、卸载与打印
- [ ] macOS Developer ID、公证、staple、Gatekeeper、正式双架构 OCI 与公开更新源
- [ ] XP-58 中文、金额、条码、走纸、切刀、断连、恢复与补打实体证据
- [ ] 每个新增 Web 功能的 Electron/Runtime/CUPS 同步适配
- [ ] v1 真实数据只读迁移演练与零差异 reconciliation
- **状态：** pending_stage_4_and_external_resources

### 每阶段复审与 GitHub 交付

- [ ] 每阶段运行 workspace、真实 PostgreSQL、公网浏览器与相称安全/数据库复审
- [ ] 每阶段分组提交、PR、required CI、合入并复核 `main` push CI
- [ ] 部署精确 merged SHA；前一阶段云验收通过后才进入下一阶段
- **状态：** continuous

## 当前明确后置

- Windows 打包、Windows 实机与 Windows 打印。
- Developer ID、macOS 公证、Gatekeeper、第二台 Mac 正式发行证据。
- XP-58 实体出纸；软件打印链已保留，但不阻塞云端 Web 产品功能。
- 远程云 Server 到门店 Edge 打印、Developer ID 与正式桌面发布。
- v1 迁移继续后置。
- AI/BYOK、小程序、取送、营销与通用多租户的软件设计/实现已由本次 1→4 授权纳入阶段 4；
  真实支付/通知/AI provider 仍需独立测试凭据，缺失时只交付 sandbox 与失败关闭证据。

---

# 历史计划：后续 1–6 顺序交付

以下阶段保留历史证据，不再作为当前执行入口。

### 阶段 0：集成当前 P0–P2 证据

- [x] 刷新 `origin/main` 并确认工作树边界
- [x] 分组提交 #152 真 PostgreSQL 测试补强
- [x] 分组提交 ADR-36 Cloud 验收工具与仓库文档
- [x] 新鲜运行 workspace 与真实 PostgreSQL 门禁
- [x] 经受保护分支 PR #153 推送并合入 `main`，确认远端精确 SHA 与 CI
- **状态：** completed

### 阶段 1：macOS 桌面 App 适配当前 Web 产品面

- [x] 盘点 Web/Counter/Runtime 当前差异和既有 packaged 证据
- [x] 补齐适配、回归与 packaged macOS 验收
- [x] 通过 Runtime-managed loopback + packaged Counter 真实软件组合验收
- [x] 通过工作区总门禁与独立终审
- [x] 提交、推送 `main` 并确认 CI
- **状态：** completed

### 阶段 2：XP-58 实体打印

- [x] 检查可用 CUPS 队列与 XP-58 实机；确认本机无队列、USB Printer、串口桥或 IPP 服务
- [ ] 验证中文、金额、条码/扫码、走纸、切刀、断连与重打
- [ ] 提交需要的软件修复并推送 `main`（打印入队、旁路防护与 schema v3 已实现，门禁进行中）
- **状态：** blocked_external_hardware

### 阶段 3：Developer ID、公证与正式双架构 OCI

- [ ] 检查 Developer ID、notary profile、正式 manifest 签名权威与第二台 Mac
- [ ] 生成、验签、公证、staple、Gatekeeper、干净机安装/升级/回滚
- [ ] 发布并验证 arm64/x86_64 OCI，提交并推送 `main`
- **状态：** pending_external_credentials

### 阶段 4：Windows 打包与实机

- [ ] 冻结 Windows 适配设计和安全边界
- [ ] 构建、安装、升级、打印与恢复实机验收
- [ ] 提交、推送 `main` 并确认 CI
- **状态：** pending_external_host

### 阶段 5：生产 SaaS、多店同步与运维门禁

- [ ] 新 ADR 冻结租户、容量、SLA、备份恢复、密钥与可观测性边界
- [ ] 实现并执行生产同构验收
- [ ] 提交、推送 `main` 并确认 CI
- **状态：** pending_design_authorization

### 阶段 6：AI/BYOK、v1 迁移与真实外部集成

- [ ] 分别冻结 AI/BYOK、v1 迁移、真实通知/支付的 ADR 与失败关闭边界
- [ ] 使用非生产 provider/迁移副本完成实现和验收
- [ ] 提交、推送 `main` 并确认 CI
- **状态：** pending_design_authorization

## Git 授权

- 用户已明确授权把本轮所有实现按批次提交并推送到 GitHub `main`；受保护分支要求通过 PR 和两项
  required checks，因此当前按 PR #171 执行，不绕过保护、不 force push。
- 该授权不包含 hk-vps 部署、Gitea 写入、删除分支或清理远端/历史本机资源。
- KB 仓库与 laundry-desk 分开处理。

---

# 已完成前置：P0–P2 云端 Web 产品收口

## 目标

基于 GitHub `main` 完成 #144 的 CI、hk-vps 部署与公网验收；建立当前真实路线与可跟踪
backlog；在 `desk.manpengan.xyz` 用合成数据执行完整店务验收，修复发现的缺陷，并继续把
高风险 SQL capturing-pool 测试替换为真实 PostgreSQL 证据。

## 当前阶段

P0、P1 与 P2 可安全执行范围已完成；P2 历史催取 fixture 和远端浏览器 UI 证据等待明确授权。

## 各阶段

### 阶段 0：刷新基线与并发边界

- [x] 确认 `main`、PR #144、主线 CI、当前部署状态与工作区
- [x] 确认 hk-vps 指纹、SSH 配置和只读健康状态
- [x] 确认没有在途发布者后再接管，不并发写同一服务
- **状态：** completed

### 阶段 1（P0）：#144 CI、部署与 smoke 收口

- [x] `workspace-check` 与 `real-postgres` 主线双绿
- [x] 远端版本标识精确绑定 `ae9808c`
- [x] TLS、SPA、health、登录、refresh、受保护查询与合成写入通过
- [x] 格式错误与错误密码对外响应不可区分，内部 reason code 可区分
- [x] `kb.manpengan.xyz`、PostgreSQL loopback、Caddy/systemd 无回归
- **状态：** completed

### 阶段 2（P1）：当前真源、路线与 backlog

- [x] 更新仓库当前计划与外部 KB `status.md` / `next-phase-plan.md`
- [x] 明确“产品功能完成”的当前范围和后置范围
- [x] 把云端产品收口旅程拆成可跟踪 GitHub issues/milestone
- [x] 旧 M2–M6/Grok 计划只保留历史属性，不再作为执行入口
- **状态：** completed

### 阶段 3（P2）：云端完整店务验收

- [x] 使用纯合成数据覆盖双管理员、价目、开单、部分现金收款、履约/取衣与会员生命周期主链
- [x] 覆盖会员充值/赠款/本金退款/冻结/解冻/关户及今日/职员账目增量
- [x] 补齐员工凭据、独立欠款/退款、冻结资金拒绝、月结/CSV 等可安全公网验收项
- [x] 在固定保留窗口关闭并幂等回读历史空日，确认当天营业日仍开放
- [ ] 催取历史 fixture 保持失败关闭，等待隔离数据路径或明确授权
- [ ] 远端浏览器 UI 证据保持独立 pending，不把公网 API 冒充 UI
- [x] 对每个失败先定位根因、补回归，再修改验收脚本
- [x] 验收后停用合成价目、收口业务状态、登出会话并清理 VPS 临时目录
- **状态：** blocked_on_explicit_authorization

### 阶段 4（P2 技术线）：真实 PostgreSQL 证据加固

- [x] 重新统计仍定义 `createCapturingPool` 的业务测试并按证据性质分类
- [x] 为统计现金合成与照片引用/孤儿清理补真实 PostgreSQL 用例
- [x] 收口跨门店现金隔离、照片审计回滚与 fixture 自清理复审发现
- [x] 定向与完整 Server 真库套件：828/828、0 failed、0 skipped
- [x] 修复 cloud 测试接线触发的 foundation 精确门禁并重跑 `workspace:check`
- **状态：** completed

### 阶段 5：复审与交付

- [x] 对生产代码变更执行 TypeScript/安全/数据库相称复审
- [x] 汇总 CI、数据库、公网、硬件与正式发布为独立证据层
- [x] 未经用户另行明确授权，不 commit、push、merge 或删除分支
- **状态：** completed

## 已做决策

| 决策                            | 理由                                       |
| ------------------------------- | ------------------------------------------ |
| P0 不与 Claude 的在途部署并发写 | 避免两个发布者同时切换 `/opt/laundry-desk` |
| 公网验收只使用合成数据          | ADR-36 禁止真实顾客 PII                    |
| 新命令/查询必须先有 ADR         | ADR-16 契约面门禁                          |
| 云环境通过不替代 required CI    | ADR-36 明确两者是独立证据                  |
| 本轮不自动提交或推送            | AGENTS.md 要求用户明确授权 Git 操作        |

## 遇到的错误

| 错误                                                    | 尝试次数 | 解决方案                                                                                          |
| ------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| hk-vps helper 子命令误写为 `run`                        | 1        | 改用受支持的 `exec --`；后续命令不再复用错误形式                                                  |
| 远端嵌套 shell/SQL/Node 引号被多层解释                  | 2        | 改用受控 stdin 脚本，避免秘密出现在 argv 或本地输出                                               |
| 首次照片真库用例使用 macOS 符号链接临时路径             | 1        | 对 `mkdtemp` 结果先 `realpath`，保持生产路径校验不放宽                                            |
| 首轮 `workspace:check` 因 README 缺 ADR-13 路线链接失败 | 1        | 恢复 ADR-13 链接并保持 cloud 测试独立接线；最终全仓已复跑通过                                     |
| 公网 refresh 同秒签发相同 JWT 被 harness 误判           | 1        | 改为强制两枚 Cookie 轮换、员工绑定与刷新后 bearer 可用；10/10 回归通过                            |
| 价目 list/停用 cleanup 错把 `is_active` 当公开投影      | 1        | 对齐 PG 合同：活动项只验 5 字段，停用后 `get.item === null`；公网复跑通过                         |
| 旧 refresh 被拒后 Cookie 清空被误判为失败               | 1        | 对齐浏览器安全语义：必须观察两枚认证 Cookie 被服务端清除；新增回归并公网复跑                      |
| 订单财务 cleanup 会清掉基础旅程的不确定标记             | 1        | 分离 `orderFinanceCleanupUncertain` 所有权，并加“不得替其他旅程清标记”的回归                      |
| live refresh 被误要求递增 session version               | 1        | 对齐真实 rotation 合同：session/version/permission 不变，仅两枚 Cookie 轮换；补漂移负例并公网复跑 |

---

# 2026-08-13 Stage 4.4 / 4.5 十八项统一交付

## 目标与发布纪律

- [ ] 18 项能力分别形成一个可审查的单提交。
- [ ] 所有实现完成后再重建统一集成链、执行全量门禁、推送 PR、合并 exact main。
- [ ] 仅在 exact-main CI 全绿后一次性部署 hk-vps；中途不部署任何单项。
- [ ] hk-vps 在最终发布前继续保持已验证的 f276/0048 稳定态。

## 当前执行阶段

- [x] Item 1 已修复 R5/DB guard/UI 竞态并形成单提交 `622e6f8`，独立终审 P0/P1/P2=0。
- [x] Item 2、Item 3 已分别形成单提交并通过原分支独立终审；最终集成时需基于修复后的 Item 1 重算 0055/0056 catalog golden。
- [x] Item 4 形成严格单提交 `58bb10e`，全量门禁与独立安全终审通过。
- [x] Item 5 已形成唯一提交 `3791cb7`，focused 20/Web 448 与 Web/SPA 门禁绿；Item 6 已接续。
- [x] Item 7 四项终审阻断已修并 amend 为唯一提交 `1111f73`；Item 8 已终审通过。
- [x] Item 9 已形成唯一提交 `cc30ca0`，真实 PG 与两轮独立安全终审通过。
- [x] Item 10 五项修复及 named-route 控制流绕过已闭环为唯一提交 `ce253c2`。
- [ ] Item 11 已从 exact Item 10 启动 0062 顾客钱包与偏好切片。
- [x] Item 12 已封闭 direct DML 并 amend 为唯一提交 `0a0ee50`，真实 PG 与 focused 门禁绿。
- [ ] Item 13 仅因外部 provider 凭据授权边界暂停；不阻塞其余项目推进。
- [ ] Item 14–18 未开始。

## 后续顺序

1. 关闭 Item 1、9、10 的独立复审，同时完成 Item 4。
2. 顺序完成 Item 5、6、11，并补齐 Item 7/12 的终审。
3. 在不依赖真实 provider 凭据的范围先实现 Item 14–18 的失败关闭骨架和门禁；Item 13 保持显式凭据门禁。
4. 从 `main` 新建干净集成链，按 0054→006x 迁移顺序移植所有单提交并重算 catalog/OpenAPI/freeze。
5. 执行 workspace、真实 PostgreSQL、浏览器、安全与发布门禁，随后 PR/merge/exact-main CI。
6. 一次性发布 hk-vps，并分别核对 marker、迁移账本、健康、公网旅程、回滚和 retained evidence。
