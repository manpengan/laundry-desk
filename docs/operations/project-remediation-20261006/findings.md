# 已验证事实

最后核对：2026-10-07 23:56（台北）。当前发行收尾见
[2026-10-07 计划](../windows-release-closure-20261007/task_plan.md)、
[进度](../windows-release-closure-20261007/progress.md)及[发现](../windows-release-closure-20261007/findings.md)。
下方旧轮次的结果保留其原版本，不继承为当前候选通过。

## 当前状态

- 当前 main 为 `1c16fc15f94b46168f8a76793c97e64616079891`。[PR #238](https://github.com/manpengan/laundry-desk/pull/238) 在 HEAD `939db9bc` 六项检查全绿、Runtime 25/25 通过后，于 23:30:52 普通合并；合并后 main 检查另行记录。此前 [PR #237](https://github.com/manpengan/laundry-desk/pull/237) 在 HEAD `2911c6b6` 六绿后，于 20:01:43 普通合并为 `1462e242bf580928dbfdef155bc95cd29e2959c8`；入场 `4ba4db4d` 与 PR #233、#234、#235、#236 的既有合并记录保留。
- PR #237 的 Runtime CI 原生 25/25、真实 PostgreSQL 1306 通过/1 项 Windows 平台跳过、generic 原生 49/49（含新增 13 项证据测试）均通过；双 profile 各自安装 smoke 1/1、安装后登录及合成订单重启 1/1。该次合并提交 `1462e242` 的 [Foundation](https://github.com/manpengan/laundry-desk/actions/runs/37618108462)、[PostgreSQL](https://github.com/manpengan/laundry-desk/actions/runs/37618108294)、[Counter](https://github.com/manpengan/laundry-desk/actions/runs/37618108168) 已通过，[Runtime](https://github.com/manpengan/laundry-desk/actions/runs/37618108479) 于 22:01 通过；这些历史 main 门禁不代替 `1c16fc15` 的合并后检查。
- 设置按需加载修复 `285760b7` 已推送至 [PR #239](https://github.com/manpengan/laundry-desk/pull/239)，尚未合并；本地 Web 679/679、类型/lint/格式及独立审查通过。新候选构建因会话缓存隔离守卫待修而暂停，最终构建 SHA 尚未固定；新 HEAD CI 与 Windows 实包另验。
- 已有 Windows 实机证据绑定前一产品候选 `107c592287d1f3a3c14ad8527e7a505e5930a9d8`，runner 独立固定为 `939db9bc7e45d6222f8defaac996ea4a0bac8304`。该候选于 21:31:42 在独立目录完成 Runtime `0.1.12` 和双 profile 构建；21:40–21:42 双 NSIS 管理员协助的 per-user 隔离安装、原入口恢复及实际安装树预检通过，原生独立用例 36/36。安装根目录 owner 不是当前用户，不能表述为普通用户独立安装；其后通过与失败分别记录如下，不继承为 PR #239 的新包证据。原始记录见 [实机验收](../windows-release-closure-20261007/acceptance.md)。
- 旧候选 `9b242a8a`、runner `2da506b4` 的同源 Runtime/双 profile 构建、ASAR 实际绑定和 NSIS 隔离安装已通过，公开证据已复核；原入口最终恢复。原生独立用例共 36 项（helper 4、文件系统 10、恢复维护 22）通过，重复执行不重复计数。
- `9b242a8a` 修复跨数据库结构升级及成功升级恢复时跳过默认备份初始化的问题；定向 31/31、本地 Runtime 172 通过/28 条件跳过，不能代替 Windows 原生结果。
- `run-2378c185` 已实测旧 0069→0082 升级和每日 03:00 默认备份通过，随后成对回退因 `WINDOWS_COMPANION_PROGRAM_PROBE_FAILED` 失败；原环境已完整恢复。真实 f777 旧 payload 不接受 Windows 照片目录，新产品 `107c5922` 按已验证目标 manifest 能力选择环境，保留实际照片校验与程序探针；新增 7 项回归通过，全 Runtime 207 项中 179 通过、28 平台条件跳过，独立复审 30/30。新候选 `run-18c93fdb` 已于 21:50:29 实机成对回退通过，另存本轮结果，不覆盖旧失败。
- `run-c2425755` 使用旧 `9b242a8a` 新建合成实例，实际备份校验后修改订单、删除照片数据库行与文件，再恢复订单、照片元数据和字节并完成影子演练，分项通过。generic 功能旅程在业务 UI 开始前因 `WINDOWS_FUNCTIONAL_EVIDENCE_SPA_TREE_INVALID` 阻断；21:21:29（13:21:29Z）的独立只读核验确认原入口、服务、3 项任务及双原安装精确恢复，测试残留为 0。
- 旧 helper 错误要求 bundle 内存在第二份 manifest，真实打包协议只在 SPA 顶层保存指针文件。测试修复 `939db9bc` 使用生产 `syncSpa` 创建夹具，证据/打包/清理回归 46/46、独立复审 16/16、类型检查及 lint 通过；修复仅影响验收，不改变产品 `107c5922`。双实际安装树预检及缺服务启动用例各 1/1 通过；`run-18c93fdb` 的 generic/hongfa functional 分别于 22:03:09、22:05:33 通过，原始回执与安装来源已复核。D04 随后在 `kill-owned-process-tree` 阶段因 helper 未分类异常中断，报告固定码 `D04_PRIVACY_INVALID`；未取得强杀恢复唯一性证明，后续维护 GUI、专门视觉及原生关闭未运行。22:14:02 的独立只读结果确认原环境精确恢复、测试残留 0。
- `run-18c93fdb` 的六份 Runtime 公开回执已复核：产品 `107c5922` 与 Runtime manifest `2b7b42d2…98dbab` 绑定；五里程碑于 21:56:58 全部通过，包括旧 f777/0069 合成订单与照片、升级至 0082 和默认备份、成对程序/数据库回退、保留数据重装、修改订单并删除照片后恢复并做影子演练。回退后仍运行原 f777/0069，升级后的订单变更被撤回、原照片保留；备份数据库 1,749,885 字节、1 张照片，删除后元数据与字节均恢复。该结果不等于完整 UI、跨机或长期备份验收。
- `run-7d07cb87` 的 `107c5922` Runtime 数据库/照片备份恢复与影子演练于 22:36:45 再次通过；该轮明确不覆盖跨结构升级、成对回退和旧控制器重装。generic functional 于 22:40:21 在海盐 `sea`→晴空 `sky` 的 5 秒断言失败，DOM 诊断又在 2 秒超时；根因尚未关闭。后续定向探针停在主题循环之前，不能作为此主题失败的复现或通过，也不能以首轮通过忽略该失败。hongfa、D04、维护 GUI、专门视觉、原生关窗均未进入。7 份最终回执已逐项核对大小和 SHA。
- `528fb065` 的通用版、宏发版 functional 各 1/1 和三项原生探针属于历史安装组合。锁屏 UI Automation 和任务对话框消息调用没有证明解锁桌面的真人关窗体验。
- PR #235 修复维护转交的四处断点。旧 `528fb065` 已证明健康读取、主窗口显示和授权转交，GUI 创建备份及导出在确认前取消；后续 `9b242a8a` 的实际备份恢复分项通过不能替代维护 GUI 或真人验收。
- 旧 `64aa35e0` 的构建、测试及当时 SSH 断连记录留在 [progress.md](progress.md)，不再作为本轮最终候选；D04 的已提交丢响应后强杀、原键恢复和数据库唯一性仍待当前候选实测。
- Windows 8787 的 ready 与默认 Companion 安装状态来自不同实例。`run-18c93fdb` 与 `run-7d07cb87` 均已 finally 恢复并独立只读核验。后者 22:43:58 的记录为原服务 PID 20540、来源 `unverified_dirty_development_checkout`、入口与 Node 摘要一致，3 项任务和双原安装精确恢复，所属测试进程/任务引用残留 0。发行验收必须绑定监听进程、服务目录、源码与 Runtime 清单，不能凭端口健康宣称原服务已升级；后续探针与恢复记录另见收尾进度。
- 向日葵仍停留在既有登录校验。Win11 历史宿主路径最新复核仍为 DERP 后转 IPv4 直连，未满足 Linux SSH 技能的 IPv6 条件，尚未登录该宿主；路径例外尚未获答复，不能认定 Win11 当前资源或真人远控已可用。
- 用户本轮已授权提交、推送并合并全部 PR；ADR-98 仍为 Proposed，真实数据未准入。Win11、跨机/跨 SID、长期备份、签名策略、真实渠道及真人验收的资源和通过标准见 [本机准入手册](local-admission.md#外部验收资源与通过标准)。

## 2026-10-06 原审查与实现事实

- 原审查报告：output/project-audit-20261005/audit.json；UI 82/100 不是生产放行分。
- main 已包含 PR232 的扫码预付、userdata 接管及 Windows 后续修复，旧报告的“PR232 未合并”已过时。
- PR233 提交 614b423c 的 Foundation/macOS/PostgreSQL/Windows Runtime 均已通过；本轮新改动必须重测。
- 原审查确认 D01 客户详情缺少请求代次保护、D02 欠款错误转成功空态、D03 上传固定第一件衣物；本轮均已修复并通过定向与整合回归。
- D04 必须同时处理草稿和主进程幂等身份，不能仅持久化 renderer 文本或把已有离线队列视为完成。
- Windows SSH 使用固定 skill wrapper，复杂 PowerShell 用 UTF-16LE EncodedCommand；不读取私钥。

## 2026-10-06 早期整合结论（历史）

- D01–D08、U01–U08 均已实现。D08 用稳定价目编码消除同价多品名歧义；历史空快照保持回退，不伪造历史名称。
- D04 复审发现首次 401 后自动重试丢响应会保留旧失败回执，现已在新一次尝试前清除失败回执；原操作未知时不能创建新身份。
- D07/U08 的健康摘要与维护转交使用受限意图、固定 Runtime 绑定和当前会话权限复核；独立复审未确认阻断。
- `workspace:check` 第 4 轮全链退出 0；浏览器第 2 轮 28/28；新数据库第 2 轮 1305 通过、1 项 Windows 原生 DPAPI 跳过、0 失败；D06 独立 PG 1/1，复审回归 17/17。
- 数据库原始日志为 Node 25 `spec` 输出，严格 TAP 解析器不兼容；不将成功测试摘要表述为解析器验证成功。日志位置见 [progress.md](progress.md)。
- 当时 V01 编写与类型/lint 已完成，远端及 Windows 运行待验；之后的执行与合并记录见 [progress.md](progress.md)，最新候选状态见上方。
- 当时 Windows Session 1 锁定、向日葵离线，同 SHA 构建与服务切换仍在准备；此状态不能覆盖后续已记录的安装与 functional 结果。
- ADR-98 为 Proposed；R02 文件完成不等于真实数据准入。V02–V08 的外部实机、长期和真人证据仍待补，不虚报完成。
- O01/O02 保留原可选产品决策；异步澄清超时无答后，本轮不纳入，不计为已实现或已交付。

## 2026-10-07 后续设置与会话隔离调查

- `theme-b3e8126a` 在主题循环前的分区选择失败；实际主进程心跳间隔 6587 ms，renderer 与测试 Node 心跳持续。只确认主进程停顿，没有单个 helper 耗时证据。
- 设置页所有分区仅隐藏而仍挂载是已定位的读取放大因素。`285760b7` 改为按需首次挂载、已访问保留草稿；旧实现负对照 8 项失败，修复后针对性 23/23、全量 Web 679/679、类型/lint/格式与独立审查通过，已推送 PR #239。
- 合成测试在真实缓存实现中复现 query 在维护等待期间切会话后，使用新会话处理旧查询结果及串读的逻辑缺口；完整 Runtime/HTTP 链路可达性与具体时序尚未证实。无真实客户数据泄露证据；最终 query/cache 与 command fallback/queue 守卫已在 `fecb90c4` 完成，并经新增 37 项行为回归、offline/HTTP 126/126 与独立安全复审。
- PR #239 首轮 helper staging 失败已通过同步精确 SPA 产物修复，原源码干净检查保留；最终 HEAD `7248c79f` 五项 CI 通过后普通合并为 main `1055ed0e`。
- Windows `fecb90c4` 同源构建、双隔离安装与当前 Runtime 数据库/照片恢复已通过；generic functional 在取衣重载原 5 秒判据失败，后续专项未运行。原环境精确恢复，诊断接续；不沿用旧 `107c5922` 的完整验收。

## 查询缓存后续修复（2026-10-08 02:35）

`a2ab1d9c` 已提交推送至 PR #240；减少重复授权/查询缓存落盘并修复 128 条容量淘汰遗漏。定向 130/130、完整 Edge 717 通过及 2 项平台跳过、类型/lint/独立审查通过。新 Windows 安装包及未完成专项继续，以最新候选实测终态为准。
