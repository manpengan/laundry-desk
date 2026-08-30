# 发现与决策

> **本文件已纳入版本控制，且仓库是公开的。** 写入前自查：不得出现密钥、口令、PIN、release
> token、真实顾客 PII，也不得记录主机上凭据文件的具体路径或变量名（这类定位信息发到公开
> 仓库等于给出半张地图）。运维私有细节留在主机侧记录，本文只写判据、结论与可复核的标识。

## 2026-08-30：Windows V2 桌面交付边界

- 桌面在线 cold resume 与普通 login 不能只共享最终 SessionView；PIN 快速切换还依赖当前认证态下的
  严格员工目录。目录应由 host adapter 私有持有，在线 resume 成功后用同一认证态补载，不能为了
  补载再次旋转 token；目录加载失败必须注销并返回未恢复，不能留下“已登录但无可切换员工”的半态。
- 恢复路径不能借用员工管理查询：`staff.access.list` 需要 `staff_write`，会让普通 `staff` 角色在
  合法 session 冷启动时被错误注销。桌面认证目录必须走权限语义匹配的固定 `/api/v2/local/staff`
  端点、不得携带 renderer token，并在 logout 与迟到响应竞态中保持注销优先、不得复活旧会话。
- 价目代码唯一不代表服务/分类组合唯一。服务端价格权威若命中多个 active 行，应按价格集合裁决：
  全部整数分价格相同即可确定解析；出现两个不同价格仍必须 `RESOURCE_UNAVAILABLE` 失败关闭。
  直接要求命中行数等于一会把合法的等价别名误判为价格歧义。
- 登录失败已经在表单内以 `role=alert` 明确呈现；同一错误再进入全局 toast 会跨过成功登录的组件
  切换并短暂残留在工作台，形成相互矛盾的状态反馈。认证失败保留表单内错误即可，字段缺失等本地
  校验仍可使用短时 toast。
- 全功能桌面验收不能只断言 UI toast。最终证据应同时绑定：安装树与当前打包 `app.asar` 摘要、
  安装版 Electron 行为、renderer/HTTP 错误计数、私有账号文件检查、只读 PostgreSQL 账本投影、
  回环 listener/进程身份和退出后的 revoked session；这些层次本轮均已闭合。
- 支付表 `amount_cents` 始终保存正整数，退款通过 `kind=refund` 与引用原支付表达负向贡献；数据库
  审计不能直接 `sum(amount_cents)`。权威签名投影是 pay/repay 正向、refund 负向、reversal 按被反转
  行的贡献取反，本轮 3 条流水按该规则精确回到订单 `paid_cents=2000`。
- “全面功能验证”须先明确证据边界：本轮以一名通过产品 UI 创建的合成测试店长驱动真实安装版
  Electron，覆盖可重复、可回滚或可审计的柜台核心旅程和全部导航面；实体打印、外部 provider、
  不可逆隐私操作、生产恢复/签名及真实顾客数据必须继续单独失败关闭，不能用软件 smoke 替代。
- 安装版窗口显示“本地服务尚未就绪”时，不能仅凭 Electron 进程存在判定桌面可用。用户实操暴露
  当前 NSIS 只安装 Edge/Electron；固定回环地址的 Fastify 服务没有监听 8787。Clash 正常运行且
  WinHTTP direct，因此出海代理与 localhost 服务缺失是两条独立问题。
- 正确修复不能把 health 硬编码为成功、绕过 `ServiceGate`，也不能把 Fastify/PostgreSQL 偷塞进
  Electron 主进程。应保持 ADR-14 的进程隔离，在 Windows 提供可审计、可恢复的独立本地服务生命
  周期，并把它纳入安装与桌面验收。
- ADR-67 冻结 Windows 为独立 Runtime + Counter：development 层允许复用构建机 Node 与仓库产物，
  pilot 层必须携带固定 Node/Server/migration/PostgreSQL payload，完成 no-repo 生命周期与签名；两层
  都不得把 Fastify/PostgreSQL 生命周期转嫁给 Electron。
- 原生 development Runtime 已在同一 Windows 10 实机以 PostgreSQL 16.15 完成 69 条连续迁移、真实
  bootstrap、kit verify 与 loopback health；PostgreSQL/Server 只监听固定回环端口，登录任务的完整
  stop/start 后重新进入 ready，证明修复的是服务链而不是 UI 假状态。
- 真正安装版 EXE 的 `_electron` 验收覆盖私有 handoff 登录、可用柜台工作台、进程关闭后重开和会话
  恢复；因此当前用户报错已关闭。该证据不覆盖 no-repo companion、签名、实体 XP-58 或真实顾客数据。
- Windows PowerShell 启动 `pg_ctl` 时若把 native stdout 留在安装器管道中，后台 postgres 会继承
  管道并让调用方长期等待；`Start-Process -Wait` 也会等待整个后代进程树。当前改由
  `System.Diagnostics.Process` 隔离 shell 输出句柄，只等待直接 `pg_ctl` PID 并检查 exit code；实机
  探针中 start 在 340 ms 返回且 PostgreSQL 保持监听，随后 fast stop 清空端口。此次调试还纠正了
  `postgres --version` 输出前缀假设。
- 独立安全复核发现 development launcher 原会继承登录环境；若残留
  `LAUNDRY_CONTAINER_RUNTIME=1`，Server 可改绑 `0.0.0.0`。launcher 现显式清空 container/LAN/public
  拓扑、Node 注入和未启用的照片/打印目录变量，并以污染环境启动后仍只监听 loopback 的实机回归锁定。
- Task Scheduler 的硬停止会把 `0xC000013A` 传播给任务树里的 PostgreSQL backend，不能作为安全停机。
  development 任务现禁止 hard terminate；受控 stop 先临时禁用自动重启、验证 8787 listener 的 Node
  身份并结束 Server，再由 stopper 直接执行 `pg_ctl fast`，最后恢复任务可用状态。不能依赖 Task
  Scheduler 下的 batch 在 Node 退出后继续执行清理。恢复验收检查 WAL、data checksums、69 条 migration
  ledger、`pg_is_in_recovery=false` 与真实 health；修复后的 clean shutdown/ready 晚于最后一次硬终止。
- 活动 V2 已有 Electron 宿主，Windows 发行应扩展该宿主；根目录旧 V1 只作历史参考。调用根
  `build:win` 会打错产品，不是捷径。
- Windows 上目录以只读 handle 调用 `FlushFileBuffers` 会拒绝访问；使用带写权限且带
  `FILE_FLAG_BACKUP_SEMANTICS` 的目录 handle 可成功。文件替换可用 `MoveFileExW` 的
  `REPLACE_EXISTING | WRITE_THROUGH` 保持落盘语义。
- Windows 的 `0600/0700` 不能由 POSIX mode 位替代。私有文件与目录必须拒绝 reparse/hard-link
  绕过，关闭 ACL 继承，并只授予当前用户与 SYSTEM 必要权限；检查必须比较实际 security descriptor。
- 原生 helper 必须是固定命令、固定参数语法和有界输入输出，并在每次调用前校验受信摘要；不得
  退化为任意 shell、PowerShell 或不校验的 sidecar。
- 密钥的 Windows 首期边界为 DPAPI CurrentUser；它不等价于硬件密钥保护，因此需要用户级运行、
  私有 ACL、日志禁密和恢复/迁移门禁作为补偿控制。
- 票据打印不是从零实现：现有 `usb-port.ts` 已有 win32 直连。主路径应放在已签名 executor seam
  后调用 Windows RAW spooler；COM/LPT/USB 直连保留为明确配置且可审计的退路。
- 桌面验收的最小权威对象是安装/解包后的活动 V2 Electron 进程和窗口。系统浏览器可以辅助检查
  服务，但无法证明 preload、IPC、打包资源、native helper、打印或安装升级链路。
- Windows 的 Node `chmod(0600/0700)` 与目录 `fsync` 都不能作为安全/持久化证据：前者不表达
  DACL，后者直接返回 `EPERM`。共享 helper 迁移后，Edge 404 项和 Server 1167 项均为 0 fail，
  证明这些差异应由平台原语解决，而不是放宽调用方测试。
- 秘密文件读取不能只依赖 `O_NOFOLLOW`：Windows 会忽略这类 POSIX 语义。读取边界必须先后比较
  `lstat/fstat` 对象身份，并独立验证 reparse、link count 与私有 DACL；错误只返回稳定安全码。
- 收紧 DACL 不能无条件调用 `SetOwner(current)`。受限登录令牌即使已是 owner，也未必有
  `WRITE_OWNER`；正确做法是 owner 已为当前用户时只改 DACL，提升管理员且 owner 精确为
  `BUILTIN\\Administrators` 时才归一化 owner，其他身份全部拒绝。只在提升 SSH 测试会漏掉该缺陷。
- Windows 锁屏时 `CopyFromScreen` 会得到锁屏/桌面背景，即使目标进程已有窗口句柄，不能当应用
  截图。可靠的远程桌面证据应组合：Playwright `_electron` 验证行为和 webPreferences，登录会话任务
  证明 Session/窗口，`PrintWindow(PW_RENDERFULLCONTENT)` 只渲染目标窗口，并人工检查最终截图。
- NSIS 的首次安装、同版本修复安装和卸载可远程自动验证；真正“升级”仍需两个不同版本。修复安装
  应清掉旧安装树残留并保留 AppData，卸载应移除程序、快捷方式与注册表但按策略保留 AppData。
- 软件层发现的打印队列不包含 XP-58。Winspool 接受队列枚举/失败分类不等于出纸，实体中文、金额、
  条码、切刀、断连和重复保护仍必须在宏发现场逐项取证。
- 进程就绪探针不能把 PID 文件“已创建”等同于“内容可读”：创建与写入之间存在真实竞态。等待逻辑
  必须校验文件内容是合法正整数 PID，才能避免把空串解析成偶发门禁失败。
- 跨层静态门禁应检查当前模块实际承担的责任。Electron session 只需断言调用统一 scheme wrapper；
  `standard/secure/cors/fetch` 等特权注册不变量由 wrapper 自身单测独立锁定，避免重构后保留失真的
  文本匹配。

---

## 2026-08-27：被取代的实现里那个会误拒的守卫

> 本节由 Claude 追加。结论对后续维护 `--retire-superseded-rollback` 有直接影响。

- Claude 8-15 版 `assertSupersededRollback` 的守卫写的是 `if (bound.length !== 1) fail(CODE)`，
  即要求回滚树**恰好**被一条 history 记录绑定。这在真实数据上是错的：一次失败尝试与随后
  成功的发布如果 `expected_sha` 相同，两条记录会指向**同一个** rollback 树路径。
  8-15 当天的 `laundry-desk.rollback-b80ab3e…-before-c04f858…` 正是这种情况——同时被
  `c04f858 rolled_back` 与 `c04f858 committed` 引用。**该守卫会拒绝掉最该退役的那棵树**，
  在最需要它的场景下失效。
- `198b0d0` 合入的版本改为：要求恰好一条 `committed` 且 `authoritative=true` 的权威记录，
  额外绑定只允许是 `rolled_back` 且非权威、且 `candidate_sha` 与 `expected_sha` 与权威记录
  一致；并有专门用例 `superseded rollback accepts one committed authority plus an earlier
failed retry` 盯住它。维护这条路径时不要把守卫简化回“唯一绑定”。
- 同一版本另有两处强化值得保留：`authority.expected_sha !== markerSha` 把树自身的 release
  marker 绑进身份校验；`liveIsCommitted` 额外要求 `verification_evidence_authoritative === true`。
  另新增只读盘点子命令 `--list-superseded-rollbacks`。
- 一般性教训：**“恰好一条绑定”这种唯一性守卫，在同一 `expected_sha` 可以产生多条 history
  记录的模型里是错误的直觉**。判据应当落在“权威记录唯一”，而不是“引用唯一”。

## 2026-08-23：Stage 5.0 → 5.1 当前裁决

- `b9ddacc…` 已成功发布并得到 authoritative machine evidence：API 20/20 PASS，Cloud Chromium
  PASS/retries=0；独立 marker、69/0069、app-role、四服务、监听和 Desk/KB 健康复核均通过。
- ADR-64 要求新工具进入 live 后再次 preflight；成功发布天然新增 live rollback 与一组完整证据，
  因而当前重新为 `/opt=6`、history/controller/backup=`8/8/8`，live preflight 正确返回
  `CLOUD_RELEASE_ARTIFACT_RETENTION_LIMIT`。这不是发布失败，而是 5.0 可持续关闭仍差一轮归档。
- post-deploy fresh superseded 推荐对象为
  `laundry-desk.rollback-7989206b3e9748b2a607687466ef2e0775ad528e-before-6f106076018940eec8fcc9e8c2cfb7842c323f47`；
  当前 release-set 唯一候选为 `7989206b…` + digest `5c851e87…a8` + `committed`。仍须先分别取得
  superseded rollback 与后续 fresh release-set 的两次精确授权，不能复用此前授权。
- 第二次精确归档已成功：manifest-bound runner 将 `53b012c…/rolled_back` 绑定的四项证据移入
  root-private archive，输出 `items=4`；write 后 history/controller/backup `8→7`，三类 room
  全 true，release-set 列表只剩应保留的 `7989206b…/committed`。
- 维护树 preflight 已以 live `c04f858…` 新鲜通过：`opt_resident=5`、`opt_prepare_peak=7`、
  history/controller/backup=`7/7/7`、两处可用空间约 15.74 GB；可进入候选 `b9ddacc…` 的标准发布。
- 用户已对 `53b012c62ae0956ca58ef4cc1b8f46091c97d5b9` + token digest
  `20d3715ada9b5aaebf30f03297d628520fea60570cf5d6a9f641f059fbc18198` + `rolled_back`
  的完整 release-set 身份授权 archive；`7989206b…/committed` 明确保留，不得替代选择。
- 第一次精确授权已完成且验证成功：`ae9808ce-before-7989206b` 以同 inode `1096495` 可恢复
  rename 到 root-private archive，55,880 项 / 909,189,258 bytes；`/opt` 常驻降为 5、峰值为 7，
  `artifact_room=true`。没有删除、数据库写入或服务重启。
- 写后 fresh release-set list 扩为两项：失败的 `53b012c…`（digest `20d3715a…98`、
  `rolled_back`）与已成功提交的 `7989206b…`（digest `5c851e87…a8`、`committed`）。为了保留
  已提交发布的恢复证据，第二次推荐精确归档 `53b012c…` 三元身份；未获独立授权前不执行。
- 用户已精确授权退役
  `laundry-desk.rollback-ae9808ce1f3dc61535dbcc1cb89e618f0350ecf6-before-7989206b3e9748b2a607687466ef2e0775ad528e`；
  授权不延伸到任何其他 superseded rollback 或 release set。执行前仍须 fresh list 复现，执行后
  必须重新建立 release-set 身份并取得第二次独立授权。
- GitHub `main` 的 Stage 5.0 工具、superseded rollback、release-set、maintenance tree 和
  inventory/preflight 已实现且精确 merge SHA checks 全绿；仓库实现不等于远端关闭。
- ADR-64 的下一步必须是新鲜只读盘点，再对一个精确 superseded rollback 和一个精确完整
  release set 分别执行受控归档；旧候选身份只作历史，不可直接复用。
- 当前用户授权覆盖实现、测试、提交、推送和部署，但对象级远端动作仍须用新鲜列表固定
  exact name/SHA/token digest 后执行；所有 runner 自行持有共享 release lock，不加外层 `flock`。
- Stage 5.1 尚无独立 ADR/细化计划。ADR-43 的数据保护内核已存在，主要缺口是生产/测试隔离、
  systemd 真实安装、独立故障域 offsite authority、实际告警接收、容量与联合恢复/事故演练证据。
- 5.0 未关闭前不实现 5.1；5.1 未关闭前不输入真实 PII，也不把 hk-vps 称为生产 SaaS。
- 2026-08-23 新鲜现场与 2026-08-20 快照一致：stable/live `c04f858…`，`/opt=6`、
  history/controller/backup=`8/8/8`，三类 room 均 false；这是 retention slot 阻塞，不是磁盘阻塞。
- 当前五个 superseded rollback 构成 `ae9808ce → 7989206b → 6f106076 → f276bdbf → 65bd8210 → b80ab3e1`
  的成功发布链。最早的 `ae9808ce-before-7989206b` 离当前 live 最远，且由新鲜 runner 列为合格；
  这是推荐对象，但在用户精确确认前仍不能执行 `--retire-superseded-rollback`。
- 唯一 release-set 候选身份已新鲜固定为 `53b012c…` + token digest `20d3715a…98` +
  `rolled_back`。它必须等 `/opt` 精确退役完成并重新 list 后，再取得第二次独立授权。

## 2026-08-13：保留迁移编号的隔离分支不能冒充连续 runtime bundle

- Item 7 独立分支只有 0001–0053 与 0059；`migrate-v2` 能按正式文件名应用 54 份迁移，但
  `loadMigrationBundle()` 明确要求第 N 个文件的四位编号等于 N，因此 legacy-volume 验收必然在
  0059 处返回 `RUNTIME_MIGRATION_BUNDLE_INVALID`。这不是通过改测试或放宽连续性解决的问题。
- 0054–0058 已按路线保留给 Items 1–6；不得在 Item 7 分支伪造占位迁移、重编号 0059 或弱化
  runtime bundle 校验。Item 7 可先用静态/focused 门禁和独立审查收口，权威 fresh 0001→0059
  PostgreSQL/commissioning 必须在 0057/0058 的真实实现进入统一集成链后执行。
- fresh runner 仍应构建 `@laundry/server...` 依赖图；本次失败发生在迁移文件连续性，而不是陈旧
  Contracts/Domain dist。失败栈的精确 Compose project 已由 harness 删除，8543 无监听。

## 2026-08-13：团购幂等重放仍须比较冻结业务权威

- “同一 redemption 已存在”只能证明业务键已提交，不能自动证明当前恢复的 R4 卡与已提交
  authority 相同。PG 与 memory 在返回 replay success 前都必须先比较 schema-normalized 的完整
  `GroupBuyRedemptionAuthority`；金额、订单版本或其他冻结字段漂移时返回 `authority_drift`。
- 回归必须覆盖旧卡冻结后由另一份新 authority 抢先完成兑换，再恢复旧卡被拒；同时保留完全相同
  authority 的精确幂等 replay success。Item 9 最终提交 `cc30ca0` 已由原安全审查者确认该边界。

## 2026-08-13：后继目录摘要必须从最终前置迁移重算

- Item 1 终审补强 0054 的 SECURITY DEFINER guard 后，0055/0056 即使源文件未变，其数据库
  catalog 也会继承新增函数、trigger 与 ACL；不得沿用各自旧基线生成的 golden。
- 在独立受管 PostgreSQL 项目中按 0001→0055/0056 重算后，权威数据库摘要为：0055
  `1280/ad7ae4abf59591d39c7811dcf4fb75db87572c4589ef6f448eebf324ac083bed`；0056
  `1299/f466ee36ce5623a98cd72ff1ef7221fea85753e242ed9a4c830c3d658ee6fcf7`。cluster stable 摘要未变。
- fresh acceptance 不能只构建 server 包自身；host-side PG runners 会加载 workspace dist，必须构建
  `@laundry/server...` 的 Contracts/Domain 依赖图，否则可能验证旧产物而非当前源码。

## 2026-08-13：统一部署与当前恢复边界

- 用户最新顺序覆盖旧的“先单独部署 0053”：当前保持 hk-vps `f276/0048` 稳定基线，全部 18 项
  完成、集成、PR 合入且 exact-main CI 成功后，才从 0048 一次性迁移到最终 schema head。
- 4d331 手工恢复首次失败并非数据交换失败：新库、代码与 health 已恢复，但两个历史诊断
  transient unit 残留 systemd failed 状态，触发共享基础设施 fail-closed 门禁。只 reset failed
  状态并以同一 exact-SHA、同一 release flock 可重入执行后成功归档 transition；主库 48/0048，
  catalog 678 项 SHA 与备份 manifest 完全一致，应用角色 LOGIN 恢复。
- 当前 history/controller/backup 各 8，最终发布前必须把完整 4d331 rolled-back 四件套移入
  root-only 可恢复归档；不能删除或触碰两个 quarantine 数据库。现在无需为开发提前变更线上。
- Item 8 的第二轮独立审查证明“有 R4 确认卡”仍不等于冻结权威完整：必须冻结券 version/name/
  minimum/valid-days；campaign `FOR UPDATE` 与 ledger 聚合要拆为拿锁后新语句，避免 Read Committed
  等锁前快照；首跳异步响应也要 generation token，防旧确认卡在输入变化后复活。
- Item 3 首轮独立安全终审发现员工 Web 同类 stale-response/WYSIWYS P1：详情、会话和 transition
  首跳必须分别绑定 generation 与完整 authority key；切订单、目标、原因或会话后，旧响应不得回填
  详情或打开确认卡。数据库/RLS/状态机主路径暂未见 P0/P1，候选已退回原分支最小修复。
- Item 1 最终终审需重点核对 `0054_delivery_policy.sql`：当前数据库只限制两个 JSON 数组长度，深层
  service-area/window 形状、唯一性、版本单调、actor 与 DB time 主要由应用层保证；应由独立
  security/database review 裁决是否需在同一 Item commit 补数据库 guard。
- Item 12 最终终审需重点核对可部署 KMS 边界：生产入口当前默认 `kms=null` 并拒绝 secret 写入，
  只有 port/test fake；需确认后续 Item 13 是否提供非导出生产 authority，或 Item 12 本身仍欠生产
  KMS adapter。同时复核 store-admin 管理 org-scoped credential 的权限模型。

## 2026-08-12：多 Agent 继续执行边界

- 当前 `0/18` 是受用户固定发布顺序约束的真实状态，不是漏统计；0053 初始发布闭环成功前，
  Stage 4.4/4.5 的任何代码写入都不得提前开始。
- 多 Agent 适合并行做 bootstrap 定点修复、失败契约安全复核和后续领域架构映射；18 项自身
  共享 Contracts registry、migration head、bus composition、Web shell 与 freeze 清单，提交顺序
  仍必须串行，否则会制造迁移编号和注册表冲突。

## 2026-08-12：bootstrap 阶段错误与清理权威

- 失败可观测性不能通过回显原始 tar/Node/SSH stderr 获取；安全协议必须是 stdout 空、stderr 恰好
  一条中央 allowlist 错误码。Node 输出只有单 LF、受限长度和安全字符时才进入中央 allowlist 判定。
- staging 路径“本轮预期会创建”不等于“本轮拥有”。碰撞时不得删除；成功创建后还需绑定 dev/inode，
  清理前复核仍是同一普通目录，防止路径替换把精确递归删除扩大到外来对象。
- cleanup 失败必须在普通失败之上可见，避免遗留 archive/staging/capture 后被误判可重试；但
  `CLOUD_RELEASE_RECOVERY_REQUIRED` 优先级最高，不能被清理噪声覆盖。
- Item 1 的 `0054` 只能预配置人工区域、政策时窗、整数分运费和 policy-only quote。当前 commissioning
  readiness 冻结 `delivery=false`；若 0054 提前翻转 flag，回滚到 0053 会启动失败，因此启用预约必须
  留给后续显式、可回滚的状态迁移。

## 2026-08-12：0053 发布控制器嵌套目录回归

- controller installer 原先枚举 `tools/cloud` 一级名字后直接 `readSource()`；历史上目录里只有
  普通文件，因此测试标题虽写“recursive”，fixture 实际没有任何子目录。Stage 4.1 新增
  `tools/cloud/systemd/` 后，精确 main CI 仍绿，但真实 release 在 transition 前失败。
- launcher 的实际 inventory 已经递归遍历私有 controller tree，但 manifest path 正则只允许
  `tools/cloud/<file>` 一层；修复必须同时让 installer 安全递归、让 validator 接受每段均为严格
  basename 的嵌套路径，并在 manifest 中保持全局字典序和逐文件 SHA-256。
- 不能通过跳过 `systemd`、手改上传 tar 或放宽候选 SHA 来发布 `f2d40ce`。正确路径是补生产回归、
  形成后继主线 commit，并只发布 required/push CI 全绿的精确新 SHA。
- retention 归档与发布失败证据保持分层：两个归档均可恢复；失败后无 transition、无新 history/
  controller/backup，线上仍是 `f276bdb / 0048`，所以后续开发不能在初次云发布闭环前启动。

## 2026-08-12：阶段 4.3 店厂交接与质检边界

- 现有 `garment.status` 是加工/取衣生命周期的唯一真源，不能把出店、入厂、出厂、回店四个保管
  节点编码成新状态。4.3 单独建立 store-scoped custody ledger，并在衣物上保留当前批次锚点；普通
  取衣、上挂、流转和丢损路径在持有衣物锁后检查该锚点。
- 旧 contract-only tenant matrix 把 `production_batches` 预留为 org scope，但当前没有跨店工厂
  federation 或独立 factory principal。ADR-45 明确覆盖该占位：批次、manifest、attempt、checkpoint、
  差异处置和 QC 全部按 `(org_id, store_id)` FORCE RLS；跨店/跨组织协作另立身份与授权模型。
- 本片只交付当前门店内部员工使用的在线 Web/H5，不复用宽权限 staff 去冒充外部工厂账号，也不
  声称 GPS、签名、照片、真实手机相机或实体扫码设备已完成。新增交接/QC/差异细粒度权限，全部
  查询与命令在服务端事务内重查 `store_features.fulfillment`。
- 清点差异由服务端对冻结 manifest 和完整扫描集合做集合运算。普通节点不精确一致时只追加
  blocked attempt，不推进 custody；R4 双人处置只推进匹配件，缺件进入受控 exception，夹带件
  永不静默加入，且缺件不会被自动标记 lost。
- 新写路径锁序冻结为排序后的 order → garment → batch → attempt/checkpoint/evidence；DB 时间使用
  `statement_timestamp()`，移动端用 batch version + durable idempotency 防止双机重复交接。
- 新查询只返回票号、条码、受控状态/原因、数量、摘要和服务端时间，不返回姓名、手机号或地址；
  不进入 AI/Edge/offline。R3/R4 确认摘要必须展示完整可核对清单并绑定 manifest digest/version，
  不能继续使用“服务端已冻结某操作”这一不可核对的通用文案。

## 2026-08-12：阶段 4.2 通知最终安全收口

- 单请求 10 个目标的 R3 阈值不能防拆批。最终风险真源是在同一 store advisory 下统计滚动 24 小时
  已创建 batch recipient 数与有效 pending 预留；confirm 在同一事务把 pending 原子替换为 batch。
- 只限制数据库写入仍允许满额后的拒绝路径反复执行昂贵候选/模板查询。轻量风险检查必须在
  preparer 前执行，HTTP 还需 session/org/store 速率限制；数据库 active/rolling cap 是最终防线。
- 同一 idempotency key 的首跳重放若重新准备当前模板/provider，会把新摘要和旧冻结 authority 混在
  一起。确认摘要必须和 authority 一同冻结并直接复用，配置漂移由二跳失败关闭。
- PG lease 若混用应用时钟和数据库时钟，时钟前跳可抢占仍 active 的租约，回拨又会造成过长隐私
  阻塞。claim、renew、sweep、retry 和 accepted expiry 必须统一由数据库时钟授权。
- provider Promise 的 timeout 不能只发 AbortSignal 后继续等待；worker 必须有硬 deadline、停止续租并
  吸收晚到 Promise。真实 adapter 上线前仍必须证明 abort 后 transport 已 quiesced，不能只声明布尔能力。
- 精确本轮资源为 0 不等于全机临时目录为 0。历史卷和旧测试目录未获删除授权时必须单列，不得把
  受管 commissioning 项目清理结论扩大成全局清理声明。

## 2026-08-12：阶段 4.2 Provider-neutral 通知边界

- 软件 outbox 只能证明业务状态机，不能证明短信已发送或顾客已收到。默认 provider 必须 disabled；
  no-network fake 固定 `software_only`、费用 0，UI 和验收均禁止“已发送/送达”完成声明。
- outbox 不应保存手机号、正文或 provider payload。入队时只冻结 keyed HMAC 和消息摘要，worker 在
  网络调用前重算；终态清摘要。查询只投影 order/ticket、受控状态和错误码，Edge/AI/offline 全拒绝。
- 模板若挂在通用 `orgs AFTER INSERT` trigger，会让任意测试/维护组织自动产生 append-only 子行，
  破坏既有组织清理。新实例模板应与 `local_bootstrap_metadata` commissioning marker 同事务种入，
  升级时仅显式 backfill 已有组织。
- provider 响应不确定时只有稳定幂等 key 才可退避重试；否则必须转人工。真实 adapter 还需证明
  provider 端幂等、签名 webhook、重复/乱序回执、费用与限额，不能用本地单元测试替代。
- 共享 Cloud 验收不能创建无法安全清理的 append-only 批次。因此 Cloud API 采用 capability/状态
  只读与夹带手机号的严格负向命令；实际入队由隔离 fresh PG + Chromium 合成订单覆盖，证据分层。
- 顾客擦除和 worker 的统一锁序是 order/customer → delivery → evidence；有 live lease 时匿名化失败
  关闭，过期/待处理 delivery 同事务取消。receipt 不反向锁订单，避免 delivery → order 死锁。

## 2026-08-12：阶段 4.1 Cloud 数据保护边界

- 继承 fd 与固定 lock 文件 inode 相同仍不能证明调用者持锁。最终证明同时要求当前 PID 的唯一
  `FLOCK ADVISORY WRITE` 记录，并以独立打开的同 inode OFD 验证非阻塞 flock 必须冲突；未锁的
  精确 fd 与错误 inode 均由 Linux 集成回归拒绝。
- 清理失败不能覆盖失败返回却遗失操作身份，也不能只在进程异常里可见。备份 staging、离机
  staging、影子库和联合恢复准备的双失败均使用稳定码，保留 operation/确定性清理目标；备份
  cleanup 失败还会覆盖并持久化为最终 `last_failure.backup`。

- `pg_dump --file=<root-only staging>` 不能靠最终 chown 补救：postgres 仍无法穿越 0700 父目录。
  生产路径改为 root 先以 `O_EXCL` 打开 0600 文件，再把继承的 stdout FD 交给降权 pg_dump；恢复
  同样只消费受控 FD/固定数据库名。
- CLI 的隐藏 `--lock-held` 不能只凭 argv 信任。内部入口必须证明 fd3 与固定 release lock 的
  dev/ino、owner、nlink、mode 相同，并对继承的 open-file-description 做 flock probe。
- 叶子 `O_NOFOLLOW` 不覆盖中间目录。离机挂载还需 `nosymfollow`，并在创建、复制、发布前后反复
  绑定 staging dev/ino/realpath；文件摘要后也要 lstat 目录项确认仍指向同一 inode，最终 manifest
  摘要必须与本地已验证来源相等。
- `fstype=nfs4` 与不同 `st_dev` 不能证明不同故障域；loopback NFS 仍可能在同一主机。健康权威
  增加固定 root-only、时效受限的 deployment authority，绑定 source/fstype/remote identity/failure
  domain；缺失时只能 software_only，并且整体不健康。
- 单一 `last_failure` 会被无关动作成功清空，例如备份失败后复制昨日恢复集可制造假绿。状态必须
  分 action 保存失败，只有同一动作成功才能清；失败证据写不成时保留 operation，而非吞错清空。
- 本地 Docker PG adapter 证明数据库与照片语义，但不能替代 Linux root/systemd、真实远端挂载、
  实际告警接收或受控生产恢复。Stage 4.1 必须把这些证据保持为独立 external pending。

- 现有 hk-vps release 恢复点是停写窗口内、root-only、带影子 catalog 证明的 PostgreSQL dump，
  但它明确是 database-only/same-cluster；没有 `/var/lib/laundry/photos`、周期恢复集、离机副本或
  联合数据恢复，所以不能以现有两阶段发布代替 Stage 4.1。
- ADR-29/33 的数据库 + 照片原则可复用，但其执行权威是 macOS Runtime/Compose。Cloud 必须使用
  裸机 systemd/PostgreSQL、uid 0 和现有 release lock，且不得把恢复入口放进公网 Web/总线。
- 一致性不能靠先 dump 再在线复制照片：必须先持久化 intent，停止 Desk、激活 `laundry_app`
  NOLOGIN 并清空连接，再在同一停写窗口读取 DB 引用和逐个复制照片；缺文件/摘要漂移整次失败。
- “离机”不能由同机另一个目录或 fake mount 证明。首期 adapter 只接受独立网络文件系统并在
  目标端重新验证；没有真实挂载、传输/磁盘加密和告警接收证据时只能标记 software_only。
- 联合恢复的权威必须是同一个 manifest：代码 SHA、migration ledger/catalog、数据库和照片不可
  分别选择。任何破坏性恢复前先创建当前 pre-recovery set，失败保持服务停、应用 NOLOGIN。

## 2026-08-12：阶段 3.4 顾客档案与折扣边界

- 阶段关闭证据必须使用最终一轮新鲜计数：Server 833 pass/82 opt-in skip、Web 387/387、Edge
  460/460、顾客/会员/pending 真库组合 31/31；较早的 826/77、385 或 ADR-42 7/7 只是中间快照。
- 精确 commissioning project、验收监听与浏览器进程已经归零，但历史随机 test temp 目录无法仅凭
  名称证明归属本轮；未获清理授权时应如实保留并报告，不能把“精确项目清零”扩大成全机清零。

- 运营豁免必须覆盖同一能力的所有宿主入口。`skip_ticket_print` 若只拦 Server/Edge 打印入队，
  Web 成功页仍可调用 `window.print()` 绕过；现在由服务端返回订单冻结 waiver，浏览器入口同步
  禁用并显示原因，不能由客户端当前 profile 重新判断。
- Edge SPA 的 `spa:check` 是只读发布一致性门禁；Web/Contracts 变更静止后必须先通过 Turbo
  构建完整依赖图，再运行 `spa:sync` 发布新内容寻址 bundle，最后执行 check/test。受管历史 bundle
  由 retention 设计保留，不能手工清理或直接改 manifest。

- 活动架构中的顾客“豁免”是跳过小票、标签和挂点的运营偏好，不是可冒充签名的法律免责声明；
  真正电子合同需要文本权威、签署主体、时间戳和撤回语义，继续后置。
- 顾客是组织级资源，地址/标识也必须组织级；服务代码却是门店级，不能把 store catalog id 写进
  组织级 profile。首期只保存联系渠道、自由服务备注与流程豁免。
- merge source 的扩展 PII 必须随递归 canonical group 被检索、导出和匿名化；现有模型允许
  A→B→C，仅覆盖直接来源仍会漏掉 A。只修改新应用的 merge handler 也无法覆盖旧代码回滚后的
  合并，因此读取与隐私函数本身要递归理解 merge source，并对环或异常深度失败关闭。
- 退役地址/标识若仍保留正文，隐私导出只返回当前档案就会漏数据主体历史。首期采用数据最小化：
  替换时原子清空旧行全部 raw/normalized PII，只保留版本/类型/时间证据；匿名化仍扫全组全历史。
- 现有匿名化遗漏 audit、通用幂等结果、R3 确认卡和 Edge replay 结果；`customer.upsert`/订单的旧
  离线队列还会用原手机号重建顾客。0051 必须为通用副本增加可索引主体/purge 语义，并以每组织
  私钥 HMAC 手机墓碑同时保护 direct、旧代码和 replay；无 key 的摘要可被枚举，不能使用。
- 完整 privacy export 是 `idempotent=false`，不得持久化到通用 `command_idempotency`；响应丢失
  只能重新授权导出。未来若需续取，必须单独做短 TTL 加密 artifact。
- 新 profile query 必须显式 `customer_read` 且不进入 AI。顾客 AI 投影要改成安全 allowlist，
  不能继续整体展开 customer queries；非本地 customer surface 在 request-scoped repo 完成前保持 404。
- 既有 merge 必须重连组织内所有门店订单；新 merge 锁定并扁平化来源组，历史读取仍递归兼容。
- `discount_bps=null` 与 `0` 语义不同：null 继承有效等级，0 显式禁用等级折扣。自动折扣只作用于
  original 并冻结到订单；客户端金额、当前 profile 或当前 tier 均不能重算历史。
- PostgreSQL 没有 `min(uuid)` 聚合；递归 merge 选择唯一来源账户必须用显式 UUID 排序后的首项。
  此类 SECURITY DEFINER 事务逻辑必须由真实 PG 执行覆盖，静态 SQL 与 TypeScript 均无法发现。
- 合并并发测试的同步点要观察公共函数调用/数据库等待，而不能绑定函数内部 SQL 文本；SQL 下沉到
  `customer_merge_canonical` 后继续等待旧 `FOR UPDATE` 语句会形成测试自身死锁，误报为产品挂起。

## 2026-08-12：阶段 3.3 安全与一致性裁决

- `coupon_redemptions` 必须保留不可变消费事实；取消订单不能删除核销，也不能让券永久烧毁。
  采用 append-only reversal，并将取消、冲正和审计放入同一事务；active 状态由“没有 reversal”派生，
  因而移除 grant 的历史唯一约束但保留单 redemption 冲正唯一约束。
- 权益定义退休和按旧规则发放之间必须串行，active definition 读取统一 `FOR SHARE`；定义审计保存
  所有影响权益的非敏感字段，等级变更审计保留必填 reason，避免规则临时放大再改回后无法追溯。
- 产品基线规定同一营业日关闭后拒绝业务写；因此不只券，等级、积分、次卡与券的全部 mutation
  都必须先拿营业日锁并在事务内重查关闭状态。定义配置属于管理面，不受当天关闭限制。
- HTTP 收到响应不等于提交结果确定。网络错误、非法 envelope、5xx、`TRANSACTION_FAILED` 与
  `EVENT_DISPATCH_FAILED` 都保留原 UUID 幂等键；明确成功或业务/校验拒绝才释放，避免 response-loss
  后以新键重复扣次。确认第二跳与第一跳绑定同一键。
- 临时验收 secret 一旦在会话回显即按泄露处理；仅删除配置文件不足，必须销毁持有旧环境的容器、
  卷、浏览器 profile/driver 与完整临时根，再用四组独立随机值重建并核对精确残留为零。
- SPA 产物验证必须从源码和依赖的确定性构建开始；只构建 Web 包可能消费陈旧的 workspace `dist`，
  生成内部自洽却并非当前源码的 bundle。Edge `spa:verify` 因此统一通过 Turbo 构建 Web 依赖图后
  再执行 manifest drift check。

## 2026-08-11：阶段 3.3 会员权益边界

- 现有会员实现是组织级储值账户和只追加资金账本，不是完整会员卡系统；充值赠送档位也只是
  储值本金/赠款规则，不能冒充等级、积分、次卡或优惠券。
- “会员有效期”若直接让储值本金或赠款过期，会推翻 ADR-17/22 的退款权利并引入预付卡法规
  风险。本片只让等级和独立权益资产过期；储值仍由原账本与关户流程治理。
- 券必须把固定优惠、门槛和有效期冻结到 grant，并在服务端锁定 grant 与未收款订单后原子
  更新订单金额；让 Web 提交 `discount_cents` 或先标券已用再改单都会产生可套利的双真源。
- 积分是独立的非资金账本，不与 `member_ledger` 混写。订单积分按结清时快照授予且幂等；
  后续管理员 R4 退款不追溯重估已授积分，避免在退款事务中隐式制造积分负债。

## 2026-08-11：阶段 3.2 非首店会话的失败关闭边界

- PostgreSQL 登录、会话投影和刷新已经能按任意已认证 org/store 工作，但 catalog、customer、
  shift、photo、print 等部分 runtime dependency 仍在进程启动时绑定 `LOCAL_PROFILE`；只扩认证
  而不收窄业务面会造成错误门店依赖被调用，不能依赖 repository assert 或 RLS 偶然兜底。
- 非首店会话当前只开放 Owner 所需的精确总线白名单：三类 `reporting.owner_*`、
  `accounting.report.get/export`、`store.*` 和 `staff.*`；其他 command/query 统一 404
  `RESOURCE_UNAVAILABLE`。照片、打印 artifact、Edge replay/authority/print 同样显式拒绝。
- PIN step-up 与员工凭据完成路由必须保留：它们从会话注入 tenant，在当前事务中创建 store-scoped
  repository，是 Owner 的门店名称和员工 R5 治理必需面，不依赖 `LOCAL_PROFILE`。
- 非首店的 access projection 必须在密码登录、refresh、Bearer 和 PIN quick switch 四条入口都
  重新证明 active admin；仅在初次登录检查会让角色降级后的旧 session/refresh 继续存活。
- R5 approver role resolver 必须使用待确认命令的 org/store/staff scope 查询 PostgreSQL；固定
  `LOCAL_PROFILE` 会把第二门店治理变成永远无法完成，忽略 store scope 则会造成跨店复核风险。
- 聚焦复核确认上述边界已经覆盖 password、refresh、Bearer 与 PIN quick switch；旧 admin
  即使在不递增 `permission_version` 的情况下被降为 staff，旧 bearer/refresh 也会立刻 401。
- 该白名单是过渡性能力边界，不等于通用多租户柜台已交付；后续只有在所有旧依赖改为
  request-scoped 并补跨店真库/Browser 证据后才能移除。

## 2026-08-11：后续 1→5 与阶段 3.2 启动边界

- 阶段 3.1 已以 `f276bdb…fdca`/0048 完成代码、真实 PostgreSQL、Browser、主线 CI 与
  hk-vps 发布闭环；docs-only `main=1c25dfd…9407` 不要求重复部署运行代码。
- 用户要求 1→5 严格串行。当前只能实现阶段 3.2；会员、顾客扩展、阶段 4 和后置门禁不能
  混入同一设计/迁移/PR。
- 既有 ADR-26/27 已有单店 Owner Dashboard、三类明细和组织内授权门店只读组合，但其 LAN
  假设不能自动升级为公网 Owner 产品。必须从当前代码重新核对身份、权限、门店枚举、隐私、
  报表完整性、写操作和公网会话边界。
- 任何新增 Owner 命令/查询必须按 ADR-16 同批新增 ADR、更新 `m2-freeze.test.ts`、CHANGELOG
  与验收记录；客户端不得提交 org/store 作为租户权威。
- 3.2 关闭证据仍分为 Contracts/DB/Server/Web、本地真实 PostgreSQL、Browser、PR required
  checks、精确 merge-SHA 主线 CI、hk-vps marker/schema/API/Cloud Chromium/清理，不互相替代。
- 第 5 项含真实硬件、Developer ID、公证、Windows 主机和 v1 数据副本等外部资源；软件实现可
  继续，但相应真实验收在资源缺失时必须保留明确 blocker。
- 3.2 代码审计确认 `/owner` 当前虽然会由 Cloud Caddy/Fastify 的同源 HTTPS、Host、Origin、
  Fetch Metadata、Cookie/CSRF 与限流链保护，但产品文案、IA 和能力仍是 ADR-26/27 的“管理员
  - LAN 只读”：只有今日四卡、三类脱敏明细和授权门店组合，没有 Owner 报表入口或管理写面。
- ADR-24 已有今日/日期范围/月结/职员、五渠道双口径报表及 R3 CSV，不应重复新增报表契约；
  3.2 将把既有 `accounting.report.get/export` 接入 Owner 公网页，保持整数分、不可变账本和
  366 日上限。
- 当前身份投影、刷新校验和员工目录把会话硬限制在 `LOCAL_PROFILE`，即使认证仓库和 ADR-27
  已能识别组织内其他门店，也无法安全登录到该门店。3.2 需要把 PostgreSQL 会话显示与员工
  目录改为从服务端当前会话门店读取；memory runtime 继续只允许固定本地 profile。
- 门店管理采用“会话当前门店才可写”的边界：新增有界授权门店列表，但店主若要管理另一门店，
  必须注销并用该门店代码重新认证。浏览器不能把 target org/store 注入命令事务；店名修改和
  员工治理都在重新认证后的门店 GUC、R5 双管理员复核、业务变更与审计同事务下执行。
- 门店首期受限写面只修改当前门店显示名称，门店 code、timezone、创建/删除、跨店员工批量
  迁移和云租户投产均不开放。0049 为 `stores` 增加单调 `profile_version`，名称更新以该整数
  版本做 CAS 并由触发器推进；timezone 保持只读，避免在全业务日期依赖改为动态门店配置前
  制造口径漂移。

## 2026-08-11：阶段 3.1 价目治理边界

- 本批只关闭价目治理：停用项可恢复、活动项排序、乐观并发与 catalog-only 安全审计；
  会员增强、顾客扩展、门店管理和 Owner 完整报表不夹带。
- `catalog.item.upsert` 编辑既有记录必须携带服务端版本；并发版本不符整次失败关闭。
  新建项只能追加到活动列表末尾，普通编辑保持原顺序。
- 排序输入必须是当前全部活动项的精确快照、版本匹配且 `sort_order` 连续；数据库事务使用
  门店 advisory lock，禁止部分排序、漏项、夹项或停用项混入。
- 停用与重新启用继续复用 `catalog.item.upsert`，历史订单只读取已保存价格/附加项快照，
  任何治理动作都不得追溯重估订单。
- catalog 审计只返回动作、价目 code、时间和脱敏 staff 标识；不返回原始 payload、姓名、
  联系方式、token、secret、PIN 或跨模块平台审计字段。
- 0048 是 0047 旧代码可忽略的 expand-only 迁移；代码回滚允许数据库保留 0048，但发布仍需
  精确 compatibility、golden catalog、真实 API/Browser 与 marker/health/cleanup 证据。

## 2026-08-11：阶段 2 启动边界

- 本批只实现既定三个核心切片：权威计价/设置、支付流水/退款 Web、衣物详情/挂单恢复；
  价目排序、Owner 扩展、会员增强、通知/AI/生产 SaaS 等不夹带进本批。
- 三个切片按用户指令完成本地与真实 PostgreSQL/Browser 测试后统一部署；中间 checkpoint
  不改变 hk-vps live marker。
- 任何新增/变更命令或查询必须同批附 ADR、CHANGELOG、验收记录，并点名
  `m2-freeze.test.ts`；先审计现有能力，避免为已有契约重复新增接口。
- 金额继续使用整数分；最终价、折扣、附加费、急件费与运费的权威必须在服务端，浏览器
  不能通过提交“已算好的最终金额”绕过设置、权限、并发或审计。
- 退款继续复用现有 R4、另一管理员 step-up、只追加账本与幂等语义；Web 必须从服务端支付
  流水取得 `ref_payment_id`，不得让操作员手填内部 UUID。
- 挂单恢复必须以服务端持久状态为真源；刷新/重新登录恢复不能依赖 React 内存，也不能在
  恢复时静默覆盖设置版本、并发变更、已提交/已取消状态或附件失败。
- 当前新鲜开发基线是 docs-only `86458562…f4e`；当前运行基线仍是已验收的
  `7989206…28e`。两者差异是文档，不是部署漂移。
- 2.0 审计确认通用 `settings` 是 org scope，不能用可猜的 key 模拟店级计价隔离；ADR-38
  因此冻结独立 `store_pricing_policies`、`pricing.policy.get/set`，订单事务与设置 UI 共用
  同一 store-scoped repository。
- `order.receive/hold` 只保留折扣整数分、急件/运费布尔选择和件级 addon code 为业务输入；
  旧三段金额字段仅做兼容解析并被服务端忽略。非零折扣由 admin-only `order_discount` 条件
  权限控制，人工单价覆盖仍在本批之外。
- 件级草稿采用 `order_lines.garment_details_json` 保存颜色、品牌、瑕疵、随衣附件、备注与
  addon 价格快照；draft 不提前创建正式 garment/payment。`order.get` 扩成共同详情/恢复读模
  型，开单页以 `order.list(status=draft)` 召回。
- 退款不新增写命令：新增 `payment.ledger.list` 服务端可退投影，Web 选择原流水后复用既有
  `payment.refund` R4 confirmation card 与另一管理员 PIN。
- 新迁移冻结为 `0047_cloud_counter_trust.sql`，只新增表/带默认列与历史兼容明细；0046 旧代码
  可忽略，发布允许代码回滚而数据库保持 0047，但必须新增精确 compatibility 与 golden catalog。
- 2.1 真库证明确认 `0047` 可在空卷完整应用并可重复 reconcile；相关 Server 套件在真实
  PostgreSQL 下 838/838、0 skipped，不能只用内存 store 或静态 SQL 断言替代。
- 浏览器计价验收必须先通过设置页产生真实 R5 confirmation card，由另一位管理员 PIN 复核，
  再在开单页只发送折扣、急件/运费选择和每件 addon code；请求体缺少三个旧金额字段且服务端
  返回 ¥40.00 权威应收，才同时证明 UI 可达与信任边界生效。
- macOS `/tmp` 是 symlink；任何复用本项目私有配置校验的隔离验收都必须从 `/private/tmp`
  创建 0700 目录。放宽 symlink 校验不是修复。
- Renderer 认证权威刻意只在内存：浏览器硬刷新后必须重新登录，但服务端 draft 不受影响。
  因此“跨刷新恢复”的验收口径是刷新后重新认证，再由 `order.list + order.get` 恢复完整草稿，
  不能为了测试把 token/session 写进 Web Storage。
- `order.get` 的附加项是 code/name/price 只读快照，`order.receive/hold` 只接受 code；恢复层必须
  显式投影为 `addon_codes`，不能把读模型对象原样回灌严格命令 schema。
- 取消订单为审计保留原始 `payable_cents`，但对外已支付与欠款投影都必须归零；严格客户端
  解析器需显式接受该领域状态，不能把“应收仍可追溯”误判成取消后仍有可收欠款。
- Docker Compose 会为资源附加标准 project/config labels；验收清理应对 owned labels 做子集
  匹配并仍以精确 project/name 定位，不能用全对象相等把合法额外标签误判成非本轮资源。

## 2026-08-10：云端 Web 路线边界

- 用户已将后续关键路径改为 Linux 云服务器上的 Web Server；Windows、正式桌面发行与实体打印明确后置。
- 功能状态必须分别核对活动设计、Contracts、Server/真实 PostgreSQL、Web UI 和公网浏览器行为；任一层缺失都不能简单写成“已开发”。
- ADR-36 的 hk-vps 证据来自较早的 `ae9808c` 部署；当前 `main=6609c5e`，部署 marker、服务状态和公网 UI 必须新鲜复核后才能作为现状。
- 现有 cloud harness 主要是公网 API 行为证据，且历史催取 fixture 与远端浏览器 UI 保持 pending；阶段 0 必须把这两类缺口与真正未开发的产品能力分开。
- 新鲜只读云证据：服务健康，但远端 marker=`ae9808c`、数据库 45 migrations、旧 SPA；当前
  `main=6609c5e` 已有 46 migrations，故先部署对齐是所有云开发/验收的前置条件。
- 已开发但不能声称云 UI 收口：员工、价目、订单/履约、客户治理、会员、人工催取、账务、
  Owner 和照片。现有 cloud harness 只覆盖其中一部分 HTTP 行为，不覆盖公共域名浏览器交互。
- 计价存在高优先级设计漂移：catalog 单价由服务端权威解析，但客户端仍可提交
  `discount/addon/urgent/freight`；`pricing.min_order_cents` 只写不读且无生产消费者。第一批必须
  冻结服务端权威规则、权限/step-up 与审计，不能继续把客户端金额当门店配置。
- `payment.refund` 契约与 Server 已完整实现，但 Web 无支付流水读取，也就拿不到必需的
  `ref_payment_id`，无法执行 R4 退款。它是明确的“后端有、云 Web 没有”功能缺口。
- 2.2 已关闭该缺口：`payment.ledger.list` 在 200 行上限内复用领域账本算法，并校验订单持久投影；
  Web 的退款引用与渠道只能来自该响应，另一位管理员 step-up 后仅凭冻结确认卡续跑。
- 订单契约已支持颜色/品牌，Web 行编辑器未暴露；瑕疵、附件和件级备注尚无完整契约/字典。
  `order.hold` 能落库且草稿可列表，但开单页只在 React 内存保存 `draft_id`，刷新后不能召回编辑。
- 平台设置 UI 当前硬编码最低消费默认值，只写不读；`platform.audit.list` 有 Server/PG 能力但
  Web 无入口。价目还缺 sort_order 管理及停用项重新启用入口。
- 人工催取已经开发；真正短信/微信发送、回执、计费与失败重试完全未开发。完整会员、店厂
  批次/交接、取送、营销、AI/BYOK、小程序和通用多租户均是未来模块，不应伪装成 ADR-36
  当前验收缺口。
- 当前部署固定 `LOCAL_PROFILE`，适合单一合成测试门店；只有当目标升级为通用多租户 SaaS 时，
  才需要把租户/门店自助配置列为 P0。本轮不提前扩大到生产 SaaS。
- 云长期开发需要精确 SHA 部署、迁移前恢复点、影子 restore drill 与代码/数据库联合回滚；
  ADR-36 的现状仍是可丢弃合成测试库，不能把本地 Runtime backup 冒充云备份。
- 用户的“1–4，依次进行”视为对四阶段软件范围的明确授权；它不提供外部 provider 凭据，
  也不改变真实顾客 PII 禁止进入 ADR-36 测试库的边界。阶段 4 的通知/支付/AI 外部集成先以
  sandbox adapter、契约和失败关闭证据交付，真实提供商验收仍分层报告。
- 公网 Browser 不应在共享库创建随机业务对象：仅凭 active 列表无法证明 inactive/merged
  namespace 未碰撞，响应丢失后的匿名化清理还可能接管既有记录。阶段 1 因此采用只读
  `core_ui_subset`，完整写纵向与确定性清理由 ADR-36 API acceptance 负责。
- 发布 `finalize` 不能只看 health：必须亲自 fresh 启动 API acceptance 与 Browser subset，
  消费严格结构化结果并把 candidate/transition/run-id/digest/cleanup 证据写入 root-only 状态，
  否则人工漏跑验收仍会得到 COMMITTED 假绿。
- 所有 deploy/finalize/rollback/status 必须使用同一个远端 flock；bootstrap 私有 umask 不能
  泄漏到 runtime tree/marker。实际 SSH 会话必须使用本轮 keyscan 生成的 0600 临时
  known_hosts 并锁定 ssh-ed25519，而不是只单独比一次 fingerprint 后继续信任旧 known_hosts。
- 云恢复证据必须由 root-owned 不可替换目录持有；停服后还要终止/复核 `laundry_app` 与
  `postgres` 的 laundry_v2 残留会话。shadow restore 需要源/影子全库 owner/ACL/RLS/policy/
  function catalog 摘要与完整迁移账本摘要，不能用 `orders` 单表抽查冒充全库恢复。
- Release finalize 的 Browser 子进程必须拒绝 direct username/password/PIN，只接受当前用户
  owner 的绝对 0600 `_FILE`，并用白名单环境启动 Chromium；VPS 上 API acceptance 同样只从
  root-only file paths 取值。当前 VPS 还没有这组 release-only 文件，不能把缺文件的 skip
  冒充验收。

## 2026-08-09：后续 1–6 启动边界

- 当前 `main` 与 `origin/main` 基线为 `ae9808c`，工作树包含已完成但未提交的 P0–P2
  Cloud 验收、仓库文档和两份真实 PostgreSQL 测试补强。
- 推荐先把 #152 真库证据与 #147–#151 Cloud/文档分组提交；新提交会改变 SHA，最终云验收
  不能继续把 `ae9808c` 当作落地主线证据。
- macOS、实体打印、正式签名、公证、Windows 和生产/provider 验收必须分层；用户的提交与
  推送授权不等于授权伪造或绕过缺失的硬件、证书、账号与生产变更审批。
- 阶段 0 提交前已在独立 Compose project `laundry-stage0-019fe638` 运行完整真实 PostgreSQL
  Server 828/828、0 skipped；运行后 project 容器、精确 volume 与 `/private/tmp` 配置目录均不存在。

## 2026-08-09 P0–P2 启动

- 当前执行入口是 ADR-36 云端 Linux Server/Web；桌面、Windows、生产级云、AI/BYOK 与
  v1 迁移继续后置。
- P0 必须先确认 Claude 是否已经完成 `ae9808c` 部署，不能仅凭合并或旧屏幕重复切换服务。
- P1 需要修复两个真源断档：KB `status.md` 仍停在 PR #133，`next-phase-plan.md` 仍基于
  PR #132；GitHub open issue 为 0 不等于产品无缺口。
- P2 的公网验收只允许合成测试数据；CI、真实 PostgreSQL、公网行为、实体打印和正式签名
  继续分别报告。
- P0 已确认无需再次切换 live tree：远端 marker 已是 `ae9808c` 且主线双 CI 成功；重复部署只会
  增加停机/rollback 噪声。认证正负向与依赖服务均用新鲜行为证据复核。
- hk-vps 旧卷权威 readiness 是 `commission_required`；一次性 root-only CLI 后收敛为
  `commissioned`/2 位 active admin。第二位管理员的 username/display/password/PIN 均只写入
  VPS `0600` 文件并由 `_FILE` 引用，未回传工作站或进入 HTTP。
- GitHub 当前活动 tracker 是 milestone #7、issues #145–#152；旧 #1–#6 是已终止 v1 路线，
  只归档为历史，不删除，也不继续承接新工作。
- 剩余 6 个 capturing-pool 文件/36 个 case 不是机械清零目标：#141 已迁移数据库行为，合理保留的
  doubles 只证明 mapping、参数整形、scope、错误翻译和单语句防 N+1。优先缺口是 stats 现金合成
  与 photo key 驱动的孤儿清理；二者已补真库用例并通过完整 828/828、0 skip。
- 云端既有 Playwright global setup 锁定 loopback 并直接写本地 PG，不能指向共享云库；VPS 也无
  Chromium。P2 使用独立无秘密 API 行为 harness，浏览器证据继续与 API/PG 证据分层报告。
- 共享云库不关闭当天营业日；催取名单的 30/90/180 天条件必须等待 opt-in、可审计的 UAT 时光
  fixture。缺少这些前提时必须写 blocked，不能靠直接 SQL 或等待之外的捷径写绿。
- `member_ledger` RLS 是组织级，因为余额允许跨店使用；钱箱统计必须额外显式按 `store_id`
  过滤。仅种当前店 fixture 无法防回归，现以同组织异店 50,000 分现金干扰证明隔离。
- 通用 bus 审计失败回归不能单独证明 photo repository 复用当前事务；特定 photo register/delete
  触发器用例才会在 repository 偷开事务时变红。当前两方向都已有真库回滚证据。
- 安全子集验收的预期 blocker 不能返回 overall PASS。cloud harness 现固定用 exit 2/overall
  BLOCKED；只有真实执行错误返回 exit 1，完整 P2 仍依赖催取时光 fixture 与安全交班策略。
- refresh access JWT 不是一次性随机载荷：相同 session claims 在同一整数秒签发时 bytes 可以
  相同。公网验收应证明 refresh/CSRF 两枚 Cookie 轮换、`staff_id` 绑定和刷新后 bearer 可用，
  不能额外发明 token bytes 必须变化的合同。
- 正常 refresh 只旋转 refresh/CSRF token，不替换 session，也不递增 `session_version`；版本只在
  reuse/revoke 路径递增。harness 必须要求 session、version、permission version 保持一致，并以
  Cookie 轮换和新 bearer 可用证明成功。
- PG catalog 查询只暴露 active `CatalogItem` 的 5 个业务字段；`is_active` 是写入/存储字段，
  不是列表投影。软停用后的正确公网读回是 `catalog.items.get.item === null`。
- 公网写命令即使超时或响应损坏也可能已经提交；harness 必须在发请求前登记恢复定位信息并
  标记 `cleanupUncertain`。无法确认结果时 `safe_cleanup` 必须失败，不能因没有响应 ID 假绿。
- 公网 HTTP 可安全项已补齐员工凭据、独立欠款/退款、冻结资金拒绝、日/月/职员 CSV 与历史
  空日交班；当前脚本唯一 blocker 是 30/90/180 天历史催取。它需要 opt-in、可审计的历史
  fixture，不能用普通产品命令回填时间。远端浏览器 UI 仍与 API 证据分层 pending。
- 多个旅程不能共享一个可由任意 cleanup 清零的 uncertainty 位；每个补偿器只拥有自己的标记。
  否则后执行且没有工件的 cleanup 会掩盖前一旅程“可能已提交但响应丢失”的风险并假绿。

## ADR-36 hk-vps 云测试环境

- 云端 401 不是 Caddy、RLS、密码哈希或 permission version 问题；严格 `LoginRequestSchema`
  要求 `device_id` UUID，旧人工请求缺失该字段且按认证防枚举策略统一返回 401。
- 公网 origin 不能复用或放宽 `LAUNDRY_LAN_ORIGIN`。新增的
  `LAUNDRY_PUBLIC_ORIGIN` 只接受默认 443 的精确 HTTPS DNS origin，拒绝 IP、localhost、
  非默认端口、路径、凭据和非法 DNS label，并与 LAN profile 互斥。
- hk-vps 云测试库目前只有 bootstrap staff 与一条明确合成客户，无订单和真实顾客 PII；
  PostgreSQL 16 仅监听 localhost，Caddy 只把 desk API/SPA 反代到 127.0.0.1:8787。
- 可重复部署必须绑定一个已提交 Git SHA，在 staging 树非 root 构建、迁移后短暂停服 rename；
  `/opt/laundry-desk/.laundry-release.json` 是版本真源，旧 live 树只保留一份 rollback。
- `workspace:check` 与真实 PostgreSQL 仍是 GitHub required gates；公网环境成功不替代 CI，
  也不替代桌面 App、Developer ID、公证、正式 OCI 或实体 XP-58 证据。

## P6 新店投产与正式候选闭环启动

- ADR-31 冻结为：全新 Runtime bootstrap 在 owner 事务内建立两位独立管理员和核心 feature；
  既有单管理员安装只允许 Runtime 一次性 commission，成功后永久关闭，不向 HTTP/AI 暴露 owner。
- 日常 `staff.create`/`staff.credentials.reset` 只持久化非秘密元数据并走 R5 双人审批；密码/PIN
  只进入 creator-bound、CSRF、防重放的 credential completion 边界，Argon2id 后与激活/audit
  同事务提交，绝不进入 pending action、幂等结果、日志或证据包。
- GitHub `main=origin/main=014b5f1`，工作区干净、无开放 PR；合并后 Foundation 与
  PostgreSQL Integration 均成功。当前分支为 `codex/p6-store-productionization`。
- 生产 bootstrap 只创建一个管理员；活动契约只有 `staff.access.set/list`，没有员工创建或
  凭据生命周期。E2E 通过直接 SQL 复制管理员凭据并启用 `membership`，因此现有 Browser/
  packaged macOS 证据不等于全新空卷可自主投产。
- 阶段 1 必须先解决 commissioning 启动死锁：常规 R4/R5 需要另一位 active admin，但空店
  只有 bootstrap admin。任何例外只能是一次性、仅空店、绑定本机 Runtime/安装事务、可审计并
  在建立正常审批权威后永久关闭，不能形成常驻旁路。
- Stage 1 数据库独立复审发现两项需在放行前修复：凭据 reset 与 complete 的行锁顺序相反可
  形成 `40P01`；按组织撤销会话的普通 SQL 仍被当前门店 FORCE RLS 收窄。最终方案是两条路径
  在任何行锁前取得同一门店 advisory xact lock，并由严格绑定当前 GUC/active admin 的最小
  SECURITY DEFINER 函数在同一事务内撤销目标员工全组织 session/family/token。
- 上述两项已在真实 PostgreSQL 关闭：三连接回归明确观察 reset 等待同一 advisory lock，
  complete 成功后 reset 只得到 stale 结果且无 `40P01`；第二门店的 session/family/token
  全部撤销，非管理员与跨组织调用均以 `42501` 失败。目标集合与各 active 子表均有匹配索引，
  definer 函数撤销 `PUBLIC` 并只向运行角色授予 `EXECUTE`。
- P6 严格按空卷投产 → 无仓库运维 → 可携带数据保护 → 打印产品化 → 正式候选验收包推进；
  云与 Windows 不提前，Developer ID/公证/正式 OCI/第二台 Mac/实体 XP-58 继续分层报告。

## P6 Stage 2 新发现与裁决

- LAN disabled 是安全权威，不是 UI 标签：网关物理 stop 失败、状态原子写失败和损坏 profile 必须分别进入 durable physical/state uncertain，且后续 start 不得自动恢复。
- 任何会停服或重建 Server 的 Runtime 维护都会破坏 `network_mode: service:server` 网关命名空间；backup/restore/commission/release 都必须先静默 LAN，再按变更是否已开始决定恢复或保持停服。
- 业务已成功但 LAN 恢复失败时不能抛出诱导重试的普通错误；backup/restore/commission/upgrade/rollback 结果现显式返回 `lan_status` 与 `lan_fault_code`。
- commission 临时审批凭据的 unlink/fsync 失败不得被原业务错误覆盖；固定 cleanup 错误、二次清理和无凭据日志回归已闭合。
- required CI 必须运行新 LAN no-repo 门禁；组合编排必须在成功/失败均清理测试签名私钥，不能因子套件顺序导致假红或私钥残留。

## P5 本地发布与故障验收闭环启动

- 当前审计为 0 critical / 14 high / 9 moderate；优先修复 Electron 41.10.3、undici 7，随后处理 Vite/Router/PostCSS 和同主版本传递补丁。
- `uuid` 与 Drizzle Kit 遗留 esbuild 的 moderate 路径当前不可达；不以越过上游 semver 的强制 override 换取表面 audit=0，改用显式例外证据。
- Runtime.app 当前只有 arm64 ad-hoc install/recover，同一 manifest 可恢复中断但没有 upgrade/rollback；正式发布必须新增 ADR，不得把 rollback 元数据写成已交付执行能力。
- 有流水真实 PG 工作日虽覆盖开单/补款/取衣/日结，但尚未证明日结后订单、退款与会员资金写全部冻结且零副作用。
- 打印单包验证充分，但尚缺真实 PG claim 到 Edge fake CUPS、签名回执和 PG done 的跨包软件 E2E；实体 XP-58 仍必须外接硬件人工验收。
- Runtime rollback 不能让旧镜像直接读取升级后迁移账本：旧 bundle 的 verify 要求精确迁移集合。
  ADR-30 因此选择恢复 `pre_upgrade` 一致性快照，并先把当前数据保存为 `pre_rollback`；这是
  显式的安全降级而非伪装无损回退。
- 只比较候选与当前 SemVer 不足以防连续回滚降级；本机私有 release history 保留历史最高
  已接受版本，回滚后重新升级只能回到该版本或更高版本。
- Electron-Vite 3 + Vite 6 在 Edge 的 Turbo 依赖构建中与当前 Rollup/exact optional 类型不兼容；
  正确收敛为 Electron-Vite 4 + Vite 7 并把 Node engine 提升到其真实下限，而不是回退 Rollup。
- Runtime 的 Swift 工具链可在当前 Apple Silicon Mac 同时交叉编译 x86_64/arm64；逐架构
  编译后由 `lipo -create` 合并并在 inspect 强制精确双架构，不能只凭配置宣称 universal。
- Finder 启动的正式 Counter 不能依赖宿主 update URL 环境变量；正式 URL/channel 现在由
  release 时校验并写进签名 bundle，开发配置用不同命名空间且本地包明确 disabled。
- 正式签名工具链与外部证据继续分层：ephemeral Ed25519、命令编排和失败关闭均可本机
  自动验收，但没有 Developer ID/notary profile 时不会产生或声称正式签名、公证产物。

## P4 Owner 运营与本地恢复闭环

- 新增 Owner 下钻 SQL 首版用同一 7 参数数组配合稀疏 `$3..$7` 占位符；真实 PostgreSQL
  会因未使用参数类型不可推断而失败。现按查询生成连续参数，真实 PG 已覆盖三类明细。
- 跨店组合不能绕过 store RLS。当前先按会话 org 枚举最多 201 个候选，超过 200 整次
  失败关闭；随后逐店切 GUC、动态校验 active admin/staff active，最多返回 50 家。
- Owner 权限撤销、响应格式错误或类别切换时不得继续显示上一批明细/跨店数据；View 与
  controller 双层清空，并将成功信封严格限定为 own `execution/result` 两字段。
- LAN 仍只暴露固定 HTTPS 只读面；新增下钻与组合查询必须同步加入白名单和真实 200/
  `no-store` E2E，否则仅渲染标题会产生伪绿。
- 通用健康探针原先 `response.json()` 无界；已改为 8 KiB 流式上限，并用合法 ready JSON
  后追加空白的回归保证旧无界实现会误判为 ready。
- Runtime 真实容器验收必须等待目标数据库真正可查询，并为 tar 输入启用固定 `-i`；卷只在
  初始化容器中临时增加 CHOWN capability，业务归档容器仍 drop all/no network/read-only。
- Developer ID、公证、正式 manifest 签名权威、多架构 OCI、第二台实体手机证书安装与
  实体打印仍是独立外部门禁，不能由 ad-hoc App 或本机自动化替代。

## P4 Owner 运营与本地恢复闭环启动

- 当前真源为 GitHub `main=bc8cade`；上一批 PR #138 已交付单店只读 Owner Dashboard、
  LAN HTTPS 和持久确认/step-up 基础。
- 本批固定 1–5：step-up 显式租户查询、Owner 明细、组织内多店、LAN 接入诊断、
  备份恢复 UI 与 packaged macOS 验收。
- `status.md` 的 `e7aed46`/PR #133 已过期；能力判断以当前代码、ADR 与新鲜门禁为准。
- Developer ID、公证、实体打印和干净第二台 Mac 属独立外部证据，不能由本地模拟或
  ad-hoc packaged 验收替代。

## P3 局域网 Owner Dashboard 启动

- 用户批准按 1–5 实现并授权使用本地真实 Web Server 验收；最终需测试、提交、推送并合入
  GitHub `main`。
- 基线为 `main=origin/main=736dd13`；最近 #134–#137 已交付储值 Web、催取人工名单、
  双口径账目和会员账户生命周期，下一路线由 README 明确为 P3 Owner Dashboard。
- 已知资金确认缺口：`member.topup` R3 首跳只返回通用 `confirm_ref`，未返回服务端冻结的
  精确赠款金额和命中档位摘要；客户端不得自行重算或在二跳回传业务参数。
- 当前 Fastify、Vite 与 PostgreSQL 全部绑定 `127.0.0.1`。LAN 交付不能简单裸开
  `0.0.0.0`，必须显式设计 HTTPS、Host/Origin allowlist、Secure Cookie 与第二设备验收；
  PostgreSQL 必须继续只在 loopback。
- Owner Dashboard 首片保持只读，优先复用现有 `admin` 权限，指标复用 ADR-24 双口径；
  不夹带 AI、营销写操作、云端多店或自动消息。
- 新增 Dashboard 查询属于 ADR-16 契约面变更，必须同批新增 ADR-26、更新冻结清单、
  CHANGELOG 与被推翻的验收状态。
- Dashboard 趋势固定由服务端一次返回连续 30 个营业日，7 日视图只在前端取末 7 行；
  输入保持 strict 空对象，避免客户端日期/门店筛选产生第二权威。
- “今日取衣”必须统计 `garment_status_log` 的 `picked_up` 转换事件；“新增欠款”冻结为
  今日新单在刷新时仍未收回的当前余额；滞留件复用 ADR-23 的 open + ready/racked +
  满 30×24 小时口径，但不要求手机号且不受名单行数上限影响。
- 局域网采用同源 HTTPS 网关，Fastify 与 PostgreSQL 均保持 loopback；LAN 模式使用显式
  Origin、Secure host-only Cookie，拒绝任何转发头，不信任 TUN 自动探测结果。

## M2 本地产品化启动

- 用户批准依次实现最新 macOS 包、普通 offline grant、真实订单打印闭环、无终端
  本地运行时、XP-58/Developer ID 候选版验收，完成测试后提交推送。
- GitHub 基线为 `81b2d44`，本地与 `origin/main` 一致，无开放 PR，主线双门禁全绿；
  Gitea 继续完全不触碰。
- 仓库内 Edge SPA manifest 与现有 `.app` 停在 `734d1d0`，没有 #126–#131 的会员 UI；
  Linux CI 不能替代当前 main 的 macOS 打包证据。
- 契约将 `customer.upsert`、`order.receive`、`order.hold` 与部分打印命令标为 `grant`，
  但 Edge runtime 和 PostgreSQL replay 当前只接通 `primary_lease`。
- 当前本地服务端 worker 输出固定 UTF-8 mock 文本；Edge CUPS worker 读取宿主机绝对
  spool，两端没有真实订单签名派发与设备回执闭环。
- `.app` 只探测 `127.0.0.1:8787`，不会管理 Server/PG；现有生命周期依赖仓库、pnpm、
  Docker Compose 和终端环境变量。
- 本机 `lpstat` 显示无 CUPS destination；codesigning 仅有 Apple Development，
  没有 Developer ID Application。软件门禁与外部验收必须分别报告。
- README 和里程碑验收滞后于 ADR-16/17/18 与会员首期；CHANGELOG 的“刷卡”与实际
  `other` 支付枚举不一致。

## M1.6 启动

- 用户批准按上一批给出的 1–5 继续实现：设备签名回放入口、加密离线只读缓存、
  统一对账中心、A/B 恢复演练、脱敏诊断包与 CI 运行时维护。
- GitHub 基线为 `f673ece`，本地与 `origin/main` 一致，无开放 PR，主线双门禁全绿；
  Gitea 继续完全不触碰。
- 当前 Edge 回放通过受信 main 进程复用普通 command route；本批必须把
  device/grant/lease/epoch/seq/original staff 变成服务端持久验证的专用入口。
- draft3.1a 要求旧 epoch 回放保留不可变审计但不得自动应用领域状态；epoch/seq
  负责顺序、防重放与归属，不宣称追回已经发生的物理交付。
- 离线历史缓存只允许最近窗口只读；浏览器不持有敏感离线状态，Electron 缓存必须
  由 Keychain KEK 保护并在密钥/租户/版本不匹配时失败关闭。
- Developer ID、公证和真实跨版本发行仍是外部门禁；自动化可使用独立 Ed25519 测试
  信任根验证生产同构状态机，但不能把 ad-hoc 或测试签名报告成正式分发证据。
- 诊断包必须由固定采集器生成，不能提供任意路径、shell、数据库 dump 或队列明文。
- Stage 1 真实 PostgreSQL 揭示 POSIX 正则量词上限与 JavaScript 不同：
  `{40,256}` 会在插入时抛 `invalid repetition count(s)`；长度上限改由
  `char_length ... BETWEEN` 承担，正则只校验字符集。
- grant 与 lease 必须由签名 `grant_id` 和数据库组合外键绑定；只校验设备、门店与
  时间窗仍允许同设备不同签发批次混搭。
- PostgreSQL 支付时间按整数秒持久化，随机 UUID 不能充当同秒业务顺序；退款可在
  查询时排到被引用付款之前，后续补款会误报 `REFERENCE_NOT_FOUND`。新增数据库
  `ledger_seq` 作为真实插入顺序，引用 DFS 只承担缺失、循环和跨订单引用的失败关闭，
  不冒充独立支付行的时间权威。
- 交班统计必须只计 `open/closed`，否则同营业日 draft/cancelled 会污染冻结快照；
  内存和 PostgreSQL 来源必须保持同一状态白名单。
- R4 退款仅在进程内验证第二人不足以形成持久证据；成功事务审计必须同时记录
  `initiated_by_staff_id` 与 `approved_by_staff_id`，且不得写 PIN、proof 或 session。
- A/B 控制器原先只解除更新租约，不删除 download/extract 失败留下的候选目录；清理
  必须以整个随机 `releaseRoot` 为单位，并在 `state.activate` 成功后才保留。
- 当回退版本低于已安装安全下限时，抛异常会使打包 App 完全退出；正确行为是保留
  active/pending 权威状态，幂等记录恢复事件，启动只读/打印恢复壳并跳过自动更新。
- 恢复模式不能只在 UI 层禁写；Offline service、Primary Lease authority 和 replay
  队列 I/O 都必须各自失败关闭，且 login/refresh/query 成功不能解除永久恢复门禁。

## M1.5 启动

- 用户批准按 1–5 依次实现员工权限治理、CUPS 打印生命周期、Keychain 持久加密
  离线队列、Primary Lease 离线回放与冲突界面、签名清单驱动的 A/B 更新 I/O。
- GitHub 基线为 `77b2f38`，本地与 `origin/main` 一致，主线双门禁全绿；Gitea
  继续完全不触碰。
- ADR-14 首个本地里程碑曾后置离线权威和真实硬件，但用户现已明确开启下一批；
  实现仍必须遵守 Claude draft3.1a 的安全边界和失败关闭语义。
- 现有打印租约/产物、加密队列纯核心、Primary Lease 顺序模型和升级安全核心应作为
  可复用基础；本批重点是生产 I/O、持久性、生命周期和操作员可恢复界面。
- 物理出纸、Developer ID 签名和公证取决于本机外部资源；软件测试与外部验收证据
  必须分别报告，任何缺失都不得伪造通过。
- 离线权限只允许签名 Lease 明确授予的窄命令；退款等不可逆高风险动作继续禁止。
- 更新 I/O 必须固定来源、先验签再落入候选槽，并在队列排空、兼容性和健康检查全部
  满足后激活；失败必须保留可验证的旧槽位并自动回滚。

## M1.4 启动

- 用户批准按上一批计划依次实现完整 E2E、货架/扫码/取衣复核、客户隐私生命周期、
  自动化灾备，以及 macOS 分发/升级/实体打印验收。
- GitHub 基线为 `68860ce`；本地工作区干净，主线双门禁全绿。
- Apple Developer ID 凭据、公证账号和真实热敏打印机均属于外部资源；本批必须交付
  可运行且失败关闭的链路，但只有取得真实产物或实体出纸证据后才能标记外部验收通过。
- Gitea 继续完全不触碰；所有远程提交、PR、CI 和合并只使用 GitHub `origin`。
- Browser 验收揭示统计页首次自动查询可能在操作员输入历史日期后回写当前营业日；
  仅清空旧汇总不足以解决竞态，日期编辑也必须使在途请求失效。
- R4 客户合并的对话框标题是 dialog 的 accessible name，不是 heading；E2E 应以
  dialog 角色定位，复核人选择器使用自身稳定 class，避免与“复核人 PIN”标签前缀冲突。
- `racked` 不能继续作为通用状态迁移目标，否则衣物会在没有权威货架位的情况下进入
  待取状态；独立扫码命令把条码解析、位置写入、状态日志和货架日志锁在同一事务。
- 取衣复核采用“选中上架件条码集合精确相等”，而非简单包含；这样既拒绝漏扫，也拒绝
  客户端夹带不属于本次取衣的条码。
- 首轮服务端测试的大量 500 是契约包编译产物仍停在旧注册表导致的级联噪声；补齐
  M2/桌面命令投影并重建契约后，真实根因消失，不能把级联失败当成多个独立缺陷。
- 客户匿名化不能物理删除财务行，也不能只清 `customers`；当前语义在组织范围内清除
  已终结订单的姓名/电话快照，保留订单金额、状态和不可变审计。
- 客户档案是组织 RLS、订单是门店 RLS，普通应用查询不能完整统计跨店留存；采用仅暴露
  固定 status/export/anonymize 语义的 `SECURITY DEFINER` 函数，比授予通用 RLS 绕过更窄。
- JSON 导出避免 CSV 公式解释面，但仍必须保持下载文件名由服务端 UUID 与整数时间组成，
  不能把客户姓名或手机号拼进文件名。
- 恢复演练不能只跑 `pg_restore --list`；真实影子库第一次校验揭示迁移账本列是
  `filename/checksum/applied_at` 而不是假设的 `version`，固定查询已改为核对精确 0028
  文件名并在真实恢复库通过。
- 自动轮换只删除完整且重新验证过的恢复集；损坏集合保留并进入健康告警，避免“清理”
  掩盖唯一可用备份已经损坏的事实。
- 本地定时任务使用用户级 LaunchAgent 固定绝对 Node/脚本路径，每日 03:00 执行；
  安装动作保持显式，不在开发验收机器上擅自激活。

## M1.3 启动

- 用户批准依次实现履约状态、生产异常、客户治理、历史报表和一体化灾备，并在测试
  后提交推送。
- GitHub 基线为 `c47a1ec`；本地工作区干净，主线双门禁全绿。
- ADR-14 是当前治理真源；外部 KB `status.md` 停在 2026-07-23 的 Grok/ADR-12，
  已过期，不作为实现依据。
- Claude draft3.1a 冻结了件级状态机：
  `received → washing → ready → racked → picked_up|delivered`，
  `washing|ready|racked → reworked → washing`，并允许活动状态转 `lost`。
- 客户合并属于 R4，备份恢复属于 R5；客户列表手机号应默认脱敏。
- 真实打印机仍是外部硬件门禁；本批可以交付安全的 macOS 发现、诊断和显式试打，
  但没有实机证据时不能宣称硬件已验证。
- 批量衣物状态操作采用全原子语义：任一衣物不存在或迁移非法时整批拒绝，避免
  操作员误以为整批完成而留下隐性半成功。
- 真实 PostgreSQL 客户合并首次揭示订单表为门店 RLS、客户表为组织 RLS；合并事务
  必须同时注入门店上下文，不能只设置组织 GUC。
- 真实 PostgreSQL 履约回归揭示取衣命令仍按旧无履约模式运行；启用通用 V2
  履约校验后，`racked` 衣物可正常进入 `picked_up`。
- 一体化恢复必须先校验清单，再创建恢复前全量备份；数据库恢复和照片目录原子
  交换均成功通过故意破坏后的真实演练。
- macOS 原生打印只允许主进程发现的显式 CUPS 队列，并使用固定 `lp` 参数模板；
  当前机器没有队列，所以只证明软件发现与 fail-closed，不证明实体出纸。
- 灾备清单 SHA-256 只提供完整性，不提供来源真实性；因此所有清单路径仍必须独立
  执行严格 basename 与包含校验。原快照正则的 `.+` 接受 `/`，已收紧并补重算摘要负例。
- restore 在任何破坏性写入前创建 pre-restore 恢复集；该步骤失败时原数据未变，
  应恢复服务后再传播错误，避免把备份失败扩大成持续停机。

## M1.2 启动

- 用户批准按上一批给出的 1–5 顺序继续实现，完成测试后提交推送。
- 当前 GitHub 基线为 `e87a85b`，本地与 `origin/main` 一致。
- 现有照片后端已有鉴权上传/原图下载、SHA-256、配额和私有文件根；UI 只有上传
  与数量，尚无缩略图、查看和删除。
- 现有打印基础已有租约、Worker、文件产物下载、队列列表和重试/补打；阶段 3 应
  聚焦运行生命周期、健康状态、保留策略和前端可观测性，而不是重写队列。
- 现有客户模块已有搜索/upsert；客户详情需要聚合订单、欠款、照片和打印关系。
- 运维阶段必须保留服务器本地秘密与运行数据边界，备份/恢复不能把凭据写入
  argv、日志或仓库。
- 照片缩略图必须在服务端解码生成；直接把鉴权 URL 交给 `<img>` 无法携带 Bearer，
  也会破坏桌面凭据隔离。
- Electron 二进制读取使用独立 `photoRequest`，只允许固定 UUID 原图/缩略图 GET，
  与 JSON 通用传输及上传策略分开限界。

## 需求

- 用户批准按此前计划 1–5 依次实现。
- 完成测试后提交、推送，并给出下一批计划。
- GitHub 是交付链路；Gitea 不写入。

## 研究发现

- `main=28fa8f9`，最新 Foundation 与 PostgreSQL Integration 双绿。
- 里程碑 1 已记录达成，但 PIN UI、完整计价组成、交班仍缺浏览器 E2E。
- `OrderDetailDrawer` 当前生成 `skeleton/...jpg` 假 key，只登记元数据，没有 blob。
- `photo.register` 当前接受客户端 `storage_key`；真实文件落地前必须消除路径权威。
- 真实 PG CI 已强制 server 0 skipped；浏览器 E2E 当前 6/6。
- README 与 `apps/web/README.md` 的阶段描述落后于里程碑记录。
- 交班界面此前未提交契约必填的 `counted_cash_cents` 与
  `retained_float_cents`；mock UI 测试没有发现，真实 PG 浏览器验收稳定复现。
- 交班 `paid_cents` 是订单累计已收，`payment_cents` 只统计 `kind=pay`；
  后续补缴为 `repay`，不能混入后者。
- 原生浏览器 `fetch` 不能作为配置对象的方法直接调用，否则 Chromium 会因非法
  receiver 在请求发出前失败；端口创建时必须捕获后无绑定调用。
- Electron Builder 的显式 `files` 白名单必须随新增运行时模块同步更新；TypeScript
  build 成功不证明 `app.asar` 含有全部动态入口依赖。
- 自动升级不能只签版本号或单个安装包：签名权威必须同时覆盖渠道、安全下限、
  契约/本地 schema 边界、DMG 与 ZIP 摘要及签名回退目标，校验后再持久化单调安全
  下限。
- 正式 macOS 分发不能继承本地未签名打包路径；Release 入口必须只接受显式
  Developer ID 身份和 Keychain profile，并在构建后分别验证签名、公证票据与
  Gatekeeper。
- `lp` 退出成功不等于实体打印验收成功；软件必须取得可追踪的 CUPS job id，人工
  仍需确认送纸、裁切、内容和重复打印四项结果。本机 0 队列只能证明发现和失败
  关闭，不能证明硬件出纸。
- 隐私历史不能用手机号关联订单：手机号会被修改、合并或复用；订单必须保存稳定
  `customer_id`，手机号和姓名只作为票据快照。
- 隐私 R4/R5 双人复核的第二人不能只验证“不同且有效”：发起人必须拥有
  `privacy_admin`，第二人在创建挑战和验证 PIN 两个时点都必须重新确认为活动店长。
- 取衣条码校验必须在 PostgreSQL 锁住衣物后按当前状态重做；锁前 UI 预览只能改善
  体验，不能作为并发权威。成功取衣还必须原子清空货架位置元数据。
- 恢复轮换要保护“最新可验证恢复集”，而不是排序第一项；较新的损坏集不能导致
  唯一有效旧备份被删除。
- 恢复演练只有在影子数据库验证并成功删除后才能写成功状态；清理失败本身就是
  演练失败，否则健康页会产生假阳性。

## 技术决策

| 决策                                                       | 理由                                            |
| ---------------------------------------------------------- | ----------------------------------------------- |
| 先补验收盲区，再扩照片能力                                 | 避免新功能建立在未覆盖的营业日/权限路径上       |
| 文件名与存储 key 仅由服务端生成                            | 防止路径穿越与租户越权                          |
| 浏览器和 Electron 共享 PhotoPort，不共享通用 fetch         | 保留桌面安全边界                                |
| 文件安装使用临时文件、fsync、no-replace 与可恢复清理       | 文件系统与 DB 无法原子提交，必须可恢复          |
| Playwright fixture 复制 bootstrap 管理员哈希到固定虚构员工 | 不记录凭据，同时保持生产 bootstrap 只创建管理员 |
| 历史空营业日执行交班 E2E                                   | 验证真实 R3 双跳与 PG 写入，不冻结当前营业日    |
| 真实 PG 测试使用独立 Compose project                       | 避免旧本地卷迁移校验和与测试数据干扰            |
| 通用 `photo.register` 只保留内部命令语义                   | 外部客户端不得提交 storage key 或绕过二进制校验 |
| UI 本批只展示照片持久化数量                                | 缩略图/删除需要单独的缓存、审计和重试设计       |

## M1.5 技术决策

| 决策                                                   | 理由                                                      |
| ------------------------------------------------------ | --------------------------------------------------------- |
| 离线回放复用服务端命令总线并保留原始 idempotency key   | 业务规则与事务权威仍只在 server，Edge 不复制领域逻辑      |
| Primary Lease 以 60 秒签名租约和 30 秒保守安全余量运行 | suspend、时钟不确定或过期时宁可拒绝，不扩大双设备操作窗口 |
| 打印提交前先写 `submitting`，重启后进入 uncertain      | CUPS 调用与本地状态无法原子提交，优先避免重复出纸         |
| 更新候选必须与当前 App 同 Developer ID Team            | 防止可写 A/B 状态文件被改成任意第三方应用启动器           |
| 未签名回退目标或低于本机安全下限时拒绝激活/回退        | 保持 anti-rollback，不用“自动回退”掩盖安全降级            |
| 更新清单 URL 只允许固定无查询、无凭据 HTTPS            | 降低重定向、凭据泄露与运行时 URL 注入面                   |

## 遇到的问题

| 问题                                 | 解决方案                                                  |
| ------------------------------------ | --------------------------------------------------------- |
| GitHub Issues 大多是冻结 v1 的旧条目 | 不用作活动路线真源                                        |
| 交班 UI 漏传现金核对字段             | 补齐两个整数分输入、命令参数、结果解析与展示              |
| 浏览器照片上传无网络请求             | 捕获 `fetchImpl` 后以普通函数调用，并用品牌敏感 mock 回归 |
| 打包 `.app` 启动超时                 | 检查 `app.asar` 后确认缺模块，补 Builder 白名单和清单测试 |

## 资源

- `docs/adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md`
- `docs/superpowers/specs/2026-07-25-local-first-v2-product-design.md`
- `docs/superpowers/specs/2026-07-29-milestone-1-local-workday-acceptance.md`

# P5 Runtime 发布与中断恢复裁决

- 多文件 release 状态不能把任一普通文件当作“当前真相”；transition 必须在首个状态写之前
  持久化完整 pre/target 权威，且最后删除，重启才能在 strict load 前无歧义回到安全点。
- 代码签名身份等价不能替代制品 bytes 等价；App 全树和 ZIP/DMG 必须有稳定摘要，并在从
  私有 staging 原子发布前重新计算匹配已验证 seal。
- final rename 是发布提交点。提交点之后的 workspace 清理失败属于可运维告警，不能让调用者
  误判发布未发生并重复发布。
- 路径级 `lstat` 加一次 fd `fstat` 不足以防输入替换；受控 manifest/config 输入需在 fd
  读取前后同时复核 `0600`、nlink、size、dev/ino、mode 和 mtime。

# 阶段 1 新发现与裁决

- `member.topup` 是 R3，原 UI 只发首跳并把 `POLICY_CONFIRMATION_REQUIRED` 当失败；必须用
  冻结参数的 `confirm_ref` 二跳，不能由客户端重发原始参数。
- ADR-18 已允许 `payments.method='balance'`，但 Web 对账解析仍停在 4 种方法与 20 桶；
  合法余额结账会让整个对账快照解析失败，现同步为 5 种方法与 25 桶。
- Edge build 会自动 `spa:sync`，单纯跑 build 会掩盖提交资产漂移；门禁必须先 build Web，
  再只读 `spa:check`。

# 阶段 2/3 新发现与裁决

- Grant 不能复用 Primary lease 的序号：二者生命周期和授权集合不同；v3 使用独立持久高水位，
  而不是给旧 v2 grant 猜一个顺序。
- 签名 grant 的 `allowed_commands` 只包含普通六项；Primary 三项由同一有效 grant 上的独立
  lease 权威提供，不能混进 grant 数组形成降权绕过。
- `lp` 退出成功只说明 CUPS 接受任务；提交超时或崩溃后物理结果不可证明，必须进入
  `uncertain`，不能按打印租约自动重领。
- 当前打印生产链是两个断开的半成品：Server 模拟 spool 会直接标 done，Edge 签名 executor
  默认使用带虚构顾客的宏发演示票。真实链必须由 Server 快照摘要贯穿 capability、ESC/POS、
  CUPS job ref、设备回执和 PG 终态。
- Claude 产品规格明确 Electron 不拥有 Compose 生命周期；无仓库交付应是独立 Runtime.app，
  柜台 App 只探测 loopback Server。

# M2 收口新发现与下一步裁决

- 单元层存在 `member` 依赖不代表产品运行时已交付：`LocalRuntime`、Bus composition、默认查询
  注册表与角色权限必须四层同时接通。packaged E2E 的真实 HTTP 路径发现了该缺口，现以
  `member.account.get` 200 回归和命令/查询集合核对闭合。
- `balance` 同时属于契约、Web 展示和服务端对账聚合；只补客户端会在真实 PostgreSQL
  会员支付后抛“unsupported payment bucket”。服务端付款方法集合现与 ADR-18 一致。
- 最新 `pnpm local:acceptance` 已证明 Browser 12/12、arm64 未签名 `.app` 1/1、Server
  断线后使用同一 PostgreSQL 卷恢复；它不替代正式签名、公证、另一台 Mac 或实体打印证据。
- Runtime 容器实测 UID/GID 10001、只读 rootfs、零 capability、NoNewPrivs，照片卷与
  `/tmp` 是明确可写面；macOS Docker Desktop 对 file-backed secret 的 uid/gid/mode 有提示，
  但目标环境实测 secret 非 root 可读且写入返回 `EROFS`。
- 下一批保持证据分层：先补 XP-58 实体验收和正式签名权威，再做干净第二台 Mac 的真实
  升降级与整日故障演练；云部署和 Windows 仍在本地交付完全闭合之后。
- macOS 的 `$TMPDIR` 通常展示为 `/var/folders/...`，而 `/var` 是符号链接；需要验证配置
  “拒绝符号链接祖先”时，测试隔离路径应使用规范化 `/private/tmp`，不能为测试放宽门禁。

# 下一批 1–5 建议

1. 接入实体 XP-58，完成中文、金额、CODE128 扫码、走纸、切刀、断线、重启与补打的
   证据归档，并核对签名回执与 PostgreSQL 终态一致。
2. 取得 Developer ID 与公证凭据，建立正式 manifest 签名权威、签名多架构 Runtime
   镜像、DMG/ZIP codesign、notarytool、staple 与 Gatekeeper 门禁。
3. 在第二台干净 Mac 做无仓库安装、登录启动、真实 N→N+1 升级、失败回退和同卷恢复，
   验证正式 Runtime.app 与柜台 App 的兼容窗口。
4. 跑一次完整营业日故障演练：断网开单/收款、联网仲裁、打印不确定态、日结对账、备份
   与恢复；沉淀柜台操作 SOP、支持包和验收清单。
5. 以上本地门禁闭合后再做云部署准备（租户、备份、监控、发布/回滚）；Windows 适配继续
   作为最终阶段，不提前分叉当前 macOS 交付线。

# 2026-08-08 P4 裁决

- ADR-26 明确把明细与跨店能力留给后续 ADR；本批以 ADR-27 只新增两条 R1 查询，客户端不得
  上传组织、门店、日期、分页或行数。
- 明细汇总必须精确等于 ADR-26 三张卡；最多 50 行只截断行，不截断 totals；不得返回顾客
  姓名/手机号/内部 UUID/条码/架位。
- 组合视图不能把“当前店 admin”扩大为组织所有店：必须逐候选店切换 GUC，在 RLS 下重新
  证明同一员工是 active admin，再读取四卡，并恢复原 store GUC。
- LAN 接入只生成已验证 `/owner` URL、二维码、指纹和人工安装指引；不自动装证书、不猜网卡、
  不扩大网关代理面，诊断不回显响应体、异常、路径或秘密。
- 数据恢复属于本机 Runtime.app 的 R5 维护能力；不得新增 HTTP、Owner LAN、Electron 或 AI
  入口，只接受私有目录内 App 自建并校验的备份。

# P6 Stage 1 集成发现

- `pg-test-fixture.ts` 仍复用 `DEMO_STAFF_B_ID`，而该 ID 已冻结为第二管理员；旧 fixture 会覆盖其独立用户名、密码、PIN 与显示名。改用新的 fixture-only ID，并增加不触碰 bootstrap 两位管理员的回归。
- 0045 不能直接把既有 `laundry_local_bootstrap_ready` 改为“已 commission”语义，否则旧卷在候选升级 verify 阶段失败，而旧镜像又没有 commission 命令。基础结构升级校验与已投产业务启动校验必须分层；补旧卷升级后 commission 的 no-repo 回归。

# 2026-08-09 ADR-36 云测试环境发现

- 当前部署的 `LoginRequestSchema` 强制要求 `org_code`、`store_code`、`username`、`password`
  与合法 UUID `device_id`；缺字段和错误凭据对外都故意统一为 401。
- 公网与 loopback health 均为 ready，SPA 200、TLS 验证成功；现有 401 在 loopback 同样发生，
  已排除 Caddy 为首因。
- Claude 工作树有 `LAUNDRY_PUBLIC_ORIGIN` 配置/测试和 ADR-36 三项未提交变更；分支相对
  `origin/main` 为 3 ahead / 2 behind，包含已 squash 的历史，不能直接整分支合并。
- VPS 源码是 `/opt/laundry-desk` 的 rsync 工作副本，不是 Git 仓库；交付必须建立明确 Git SHA
  标识和可重复部署/回滚证据。
- VPS `reboot_required=yes`；维护重启必须同时保护并复验 `kb.manpengan.xyz`。
- 完整登录请求在 `http://127.0.0.1:8787` 与 `https://desk.manpengan.xyz` 均成功；此前逐项
  密码/RLS 校验无误而组合 401，是因为手工请求漏传 `device_id`，并非服务端认证缺陷。
- 公网认证闭环已验证登录、refresh/CSRF 轮换、bearer 查询、CSRF 写命令与读回；PostgreSQL
  `listen_addresses=localhost`，测试库只有一条明确合成客户且没有订单。
- systemd 的环境文件不等于任意 shell 片段，云端 smoke 只能在服务端进程环境或受控 shell
  中消费，输出必须固定且不得回显 token、cookie 或密码。
- 迁移/真实 PG 脚本不能让 EXIT trap 依赖函数局部变量：失败退出时局部作用域已销毁，会造成
  pgpass 清理失效。清理权威必须在 subshell 生命周期内保持可见，并用失败注入验证零残留。
- hk-vps 维护重启完成后，PostgreSQL、Laundry Desk 和 KB 都由 systemd 自动恢复；Laundry
  与 PostgreSQL 继续只监听 loopback，公网仅由 Caddy 暴露 80/443。

# 2026-08-10 Stage 1 finalize 真实失败

- 20:59 `finalize` 真实执行到首个远端 `api-evidence`，返回
  `CLOUD_RELEASE_REMOTE_API_EVIDENCE_FAILED`；未下载 8 个浏览器字段，也未启动 Playwright。
- 同一远端 fixture 连接目标为 `127.0.0.1:5432/laundry_v2`，PostgreSQL 的
  `inet_server_addr()::text` 实际返回 `127.0.0.1/32`。原 SQL 与裸地址比较导致真实 loopback
  被拒绝为 `fixture connection is not loopback`；使用 `host(inet_server_addr())` 后仍只允许
  精确 `127.0.0.1`/`::1`，不扩大连接边界。
- finalize 失败后线上保持 `awaiting_external_verification`：marker 为
  `1a588e791d269cc1153b243776b56f137b130b45`，migration head 为 0046；不会自动回到旧版本。

# 2026-08-12 0053 首次发布新发现

- `main@02b3883b…0d4b` 的精确 push CI 已排除候选 SHA、workspace、真实 PostgreSQL 和
  Playwright 门禁不绿；发布失败发生在 hk-vps `prepare` 的远端部署阶段。
- 本地发布器只收到 `CLOUD_RELEASE_REMOTE_DEPLOY_FAILED`，说明远端失败输出不是安全错误契约
  允许的单行形式，不能据此猜测具体根因；必须读取已回滚 history 的失败阶段或其他只读证据。
- 失败后 release status 为 `stable`、failed units=0，说明自动回滚路径已收口；尚不能据此
  声称 marker、迁移账本或候选发布成功，也不能开始后续 1→18 开发。
- 连续发布 SSH 后，自定义只读 SSH 会话曾被远端直接关闭，随后一次 helper host-key scan 也
  短暂失败；标准发布 status/主机 status 在此之前均成功。应降低连接频率并重新验证指纹后再
  读取证据，不能把该瞬时连接现象直接归因为发布首因。
- 精确 sshd PID 证据否定了“remote deploy 连接被网络中断”：该会话认证成功后 3 秒由客户端
  正常断开；稍后的 preauth reset 属于后续只读连接窗口，不能倒推为发布首因。
- 候选没有 controller/history/transition，且 controller root 与 acceptance secret root 的 mtime
  均早于本次发布；结合现有 preflight、retained controller 7/7、acceptance source/destination
  和隔离 archive import/install 均通过，失败只剩 bootstrap 在进入持久状态前的匿名 shell/entry
  路径。`releaseBootstrapScript()` 的裸 `test`/`chmod`/`sha256sum`/`mkdir`/`tar` 失败不会输出
  允许的单行安全错误码，是当前无法从失败证据继续收敛的可观测性缺口。

# 2026-08-13 Stage 4.4/4.5 集成预检

- `git merge-tree` 只读预检确认 Item 7 合入 Items 1–2 时会在运行时注册、权限面、冻结清单、
  migration README/测试与 commissioning runner 产生预期内容冲突；这些是两个并行能力都向同一
  注册表追加条目的组合冲突，最终集成必须保留双方语义，不能机械选 ours/theirs。
- Item 12 与 Items 1–2 的直接交叉仅集中在 CHANGELOG、ADR 索引和 migration README；AI 代码面
  暂无结构性冲突。最终迁移编号仍固定为 delivery 0054–0058、marketing/self-service 0059–0063、
  AI 从 0064 开始，避免重编号导致已验证 SQL 失去 exact commit 绑定。
- Item 10 当前建立在 Item 8 的旧单提交上；Item 8 修复后会 amend 改写 SHA。集成时应把 Item 10
  的单一 delta 移植到 Item 8 最终 SHA，并重新生成 OpenAPI/冻结清单，不直接相信旧父提交关系。
- Item 10 最终候选为 exact `8c5bc483bc97cc0aeddd19c7e70d720ba400066c`；tab authority 不再直接
  暴露在可读 Cookie 名中，而使用 SHA-256 base64url selector。最终集成仍须在 Item 8 的获批
  SHA 之后移植该单一 delta，并重新验证 Caddy 可信来源头契约与 canonical group session cap。

# 2026-08-13 十八项实现与集成新裁决

- Item 1 的 0054 已从浅层 JSON 校验升级为深层结构、actor、version+1、DB time 与 immutable identity guard；这改变 migration digest，因此所有后继 catalog golden 必须在最终链上重新计算。
- Item 9 使用 0063，Item 10 使用 0061；0062 应留给 Item 11。最终营销/自助顺序应是 0059 Item 7、0060 Item 8、0061 Item 10、0062 Item 11、0063 Item 9，而不是按开发完成时间机械拼接。
- Item 9 的团购 bearer code 只在浏览器本地校验并做域分离 SHA-256；契约、pending authority、数据库、审计和事件只允许 digest/last4。独立安全复审仍需重点验证 direct app-role DML、R4 replay、订单折扣原子性和摘要泄露边界。
- Item 4 的 R4 人工接管不能只依赖 approved-auto-close gate；PIN challenge 与 verify 都是异步边界，
  必须另用 session scope + confirmRef + generation token 在每个 await 后以及发送 confirm 命令前复验。
  当前修复已覆盖显式关闭、scope/选择变化与迟到成功，独立终审 P0/P1/P2=0。
- 旧 `codex/stage44-45-integration` 含修复前 Item 1 等价提交，只作冲突参考；最终应新建 integration v2，避免通过重写旧链误把过期 golden 当权威。

## Item 6 交付证据预检

- Item 5 已冻结为纯 Web `/mobile/tasks`，不新增契约、Server 或迁移；因此 Item 6 才拥有 0058，
  但应在 Item 5 exact commit 上启动，避免重复修改移动入口和 request-authority。
- 既有 `garment_photos` 是洗衣订单/衣件照片权威，强制 `garment_id + order_id`，不能把配送照片
  塞进任意衣件或放宽成 nullable。0058 应建立 delivery 专用、append-only 的证据/附件关系，并把
  文件字节继续放在私有 durable storage，数据库只保存经过认证上传路由生成的 opaque key、digest、
  content type 与大小。
- 证据必须绑定 exact `delivery_task_id + delivery_order_id + leg + task version + assignee`；只允许
  当前 accepted task 的 assignee 写入。pickup/return 完成必须由服务端在同一事务内校验证据集合后
  推进 task/order，禁止客户端分别“先完成、后补证据”。异常使用受控 reason，不保存自由文本地址、
  路线或顾客电话。
- GPS 应采用有界定点整数与精度/采集时间，而非自由 JSON/浮点；签名保存独立私有图片或摘要及
  `signed_at`，不把签名笔迹、照片、坐标写入 audit/event/AI 投影。所有附件下载走 tenant/store/task
  重新授权的 authenticated route，不能复用仅按 laundry order/garment 授权的现有照片下载判断。
- direct `laundry_app` DML 需 DB guard 固定 identity/actor/DB time/version 和 append-only；证据完成度、
  task/order 锁序、重复上传幂等、内容落盘与 DB 提交失败清理，以及顾客隐私导出/匿名化保留计数，
  都要有真实 PostgreSQL 与文件系统故障回归。

## 复审节奏调整

- 用户明确要求减少反复细审、快速实现完 18 项。后续单项采用实现者自查与一轮相关门禁；已知
  高风险问题继续 fail closed 修复，但同一差异不再反复启停 reviewer。独立终审集中到统一集成与
  最终发布前，避免审查吞掉实现并发槽位。
- Item 10 的 `2dc1b2c` 仍有一个已知必须修的 Caddy 控制流漏洞：真实 Desk handler 可先 `invoke`
  unsafe named route 到 127.0.0.1:8787，再放 safe proxy 洗白 existence-based contract。修复必须解析
  named routes、按实际执行顺序检查每个可达 Desk upstream，并对 missing/cycle/未知控制流失败关闭。

## Item 11 顾客钱包与偏好切片

- Item 11 使用 0062，直接扩展 Item 10 的独立顾客 session/authority 路由，不把顾客请求接入 staff
  command/query bus，也不把 `customer_id` 暴露给客户端。读取面应由 session canonical customer group
  派生：储值余额/最近流水、tier/积分、次卡、券包、地址与通知偏好；所有金额保持整数分。
- 钱包、积分、次卡、券均已有 0050 append-only staff 权威，顾客面只读投影，不新增充值、支付、
  积分兑换或核销写入口。顾客唯一写面只限自己的地址与通知偏好；不得允许修改姓名、手机号、
  member ledger、discount、waiver、identifier 或服务备注。
- 现有 0051 `customer.profile.set` 是 staff R3 全量替换，不能从顾客门户复用，否则可覆盖 identifiers、
  waiver/discount/service note，且 canonical merge 来源地址会丢失。0062 应提供 portal 专用 CAS 函数，
  只维护 bounded address rows 和 `preferred_contact`，绑定 current customer group、session authority、
  DB time/version；地址正文不进 access log/audit/event，日志只存计数/偏好枚举。
- 地址更新需要清晰的 canonical-group 策略：门户读取合并组全部 active 地址；写入归一到 canonical root
  的 portal-owned profile snapshot，并在同一事务锁定 group/root/profile，避免合并与更新交错。来源
  profile地址不得因一次偏好更新被静默删除；若采用替换语义，必须只替换 portal 管理集合并保留
  staff-managed来源，或在首次更新时明确迁移并锁定全部组成员。
- 新 HTTP mutation 必须沿用 tab authority、CSRF、同 source/session 限流、strict body、到期清屏；
  Web 的 wallet/assets/addresses/preferences 各异步面继续使用 generation+Abort，logout/scope切换清 PII。

### Item 11 冻结实现

- 新增三个顾客专用只读查询：`wallet.get`、`benefits.get`、`profile.get`；不新增 staff-bus command。
  唯一写入口为专用 `POST /api/v2/customer/profile`，body仅 expected_version、preferred_contact、
  addresses，customer从portal session派生。
- 0062新增 canonical-root scoped preference CAS，并给地址标记 portal-managed；门户读取canonical group
  全部active地址，写入仅替换portal-managed集合，保留0051门店来源地址。0050钱包/积分/次卡/券只建
  安全投影视图，不复制账本、不增加顾客资产写入口。

## Item 14 流式 AI 冻结实现

- 不依赖 Item13真实provider：AI专用 HTTP `POST sessions`、`POST turns`、`GET events`、`GET SSE`，
  不进入普通command/query bus或冻结清单。0065持久化session/message/event/tool-attempt/usage边界；默认
  hard-off，仅测试显式注入deterministic fake provider。
- provider port只产生typed delta/tool-call/end/error；tool loop只允许bounded synthetic/read-only allowlist，
  保持零外网、零真实key，后续Item13 adapter只能接同一port，不能扩大URL/header输入面。

## 2026-08-13 Item 16–18 统一集成

- Item 16 的 0068 审批中心与 Item 17 的 0069 自动化可在缺少 0067 时完成软件集成与聚焦验证，
  但最终连续迁移/发布仍不得伪造 0067；Item 13/15 按用户决定暂缓，因此不创建占位迁移、不发 PR、
  不部署 hk-vps。
- 最终冻结面由 Stage 4.4 的 76/61 增至 82 commands / 64 queries；automation 只允许固定
  `notification.delivery_batch.enqueue@0.1.0`，经统一 C5、事务内策略/额度锁与脱敏运行证据执行。
- 合并后的 workspace 首轮 audit、format、9 包 lint、12 项 typecheck 均通过；Foundation 的两个失败
  是验收真源仍写 0063/测试仍期待 0057，以及 Compose 已支持隔离 PG 端口而测试仍只接受固定 8543，
  均属于集成断言滞后，不应放宽生产安全边界。

# 2026-08-13：Hermes DeepSeek 凭据复用边界

- hk-vps 重新核验固定 ED25519 指纹 `SHA256:Urp+pKpu/XD45nZlT+1tYJ5VYmV5X0fXStu+zmQjv4A`，
  使用 `hk-vps` alias、root Ed25519 key-only 登录；Ubuntu 24.04 健康且无 failed unit。
- Hermes gateway 以专用非 root 用户运行，工作目录与凭据路径见运维私有记录（本文不落地）；DeepSeek 凭据存在于
  owner-only `0600` `.env`。只允许临时复制、无日志读取和一次连接验收；禁止写入 Git、命令行、
  测试快照、审计正文或用户可见错误。
- Item 13 的“连接验证”只可对 DeepSeek 声称真实通过；Anthropic/Gemini 无凭据时必须标记为
  protocol-conformant/not-live-verified。Item 15 可先用 deterministic provider 完整验证业务只读工具，
  再以 DeepSeek 做一条端到端只读问答，不得把顾客原始 PII 发往 provider。

# 2026-08-15：Claude 接手与 retention 阻塞的真实位置

- Codex 于 12:00 前后退出，最后动作是合入 PR #201 并对无主产物 `rollback-pre-ae9808c-…`
  执行 `--archive-orphan`（`/opt` 与归档根 mtime 同为 `12:00:12`）。用户明确要求由 Claude 接手
  统一收口。根目录 `task_plan.md` / `progress.md` / `findings.md` 当时停在 08-13 22:5x，
  落后两天，不能作为接手判据；真源是 `main` 的 git 历史、`docs/operations/` 与 hk-vps 现场。
- **2026-08-14 发布结果 §8 对下一次发布阻塞的判断不完整。** 它只写了 `/opt` 产物上限，
  而真正的失败关闭点是 history 计数：`assertRoomForRelease` 在 `count >= MAX_RETAINED_RELEASES(8)`
  时 fail，接手时 history 恰好是 8。`/opt` 侧按 `name.startsWith("laundry-desk.")` 过滤，
  live 目录 `/opt/laundry-desk` 不带点因而不计数，实际只有 5 个，从不构成本轮阻塞。
  归档无主产物解除的是「产物」维度，对 history 维度没有任何作用。
- `assertRetainedReleaseControllers` 要求 controller 集合与 history 记录严格 1:1（数量相等且
  逐名匹配）。因此腾 history 槽位必须同时移走绑定 controller，只动其一必然以
  `CLOUD_RELEASE_CONTROLLER_RETENTION_INVALID` 失败关闭。
- history 记录的状态字段名是 `outcome` 而非 `state`（同层还有 `phase`）。首次守卫按 `state`
  写导致 `STATE_NOT_ROLLED_BACK`，守卫在 `mv` 之前失败，未产生任何副作用——这正是先证明
  身份再动手的价值。
- 三条 `rolled_back` 里只有 `53b012c…ba64d6d3` 满足 `backup_path=null`：另两条各自绑定
  backup dump，退役它们会让 backup 目录出现 orphan（backup 与 history 也是成对校验的），
  从而把一次腾槽位放大成三类证据同时搬迁。选择依据应当是「退役后不产生任何 orphan」，
  而不只是「最早」。
- `/private/tmp` 下累计 167 个 `laundry-*` 残留目录，其中 4 份 `laundry-bootstrap-files-*`
  含 `0600` 的 admin/approver 密码与 PIN，4 份 `laundry-hk-release.*` 存有 `prepare.stdout`
  即 release correlation token。逐轮验收的清理纪律没有覆盖这些跨轮残留。

# 2026-08-15：公网 health 探针无重试导致整轮发布被瞬时抖动打断

- 首次发布 `c04f858` 在 `phase=switched`、`write_gate=released` 之后以
  `CLOUD_RELEASE_PUBLIC_HEALTH_FAILED` 失败关闭并自动回滚。**候选代码没有问题**：
  候选服务 13:03:17 启动、13:03:19 listening、13:03:20 自身 loopback `/health` 返回 200；
  此后到 13:03:35 被停止为止应用再没收到任何请求，间隔 14.3s，公网请求根本没到达应用。
- 根因是 `assertDeskHealth`（`hk-vps-release-remote-system.mjs`）里两个探针不对等：
  loopback 走 `awaitDeskReadiness(...)` 有就绪重试策略，公网只有
  `curl --fail --max-time 15 https://desk.manpengan.xyz/health` 单发、零重试。14.3s 正好撞
  15s 上限。这台机在 NAT 后（私网 `10.0.217.104`），打自己公网域名要走 hairpin，
  该路径出现一次十几秒的停顿就会把一轮已经完成停写、备份、影子恢复与迁移的发布整体作废。
- 已排除的因素：内存（可用 5.9G、swap 0 使用、窗口内无 OOM 或 kernel warning，只有背景端口
  扫描噪音）、UFW（22/80/443 全是 ALLOW，没有 `limit` 规则，窗口内无相关 BLOCK）、
  应用自身（loopback 200）。事后从 VPS 连打 3 次公网 `/health` 均为 200 / 80–160ms。
- **失败的代价被低估了**：一次失败同时消耗 history 与 backup 各一个槽位，并在 `/opt` 留下
  `laundry-desk.failed-<sha>`。本次失败把 history 7→8、backup 7→8 对，两个集合同时到顶
  （`assertRoomForRelease` 与 `MAX_RETAINED_BACKUPS` 都是 `>= 8` fail），重试前必须再归档。
- 而且此时剩余三条 `rolled_back` 全部绑定 backup dump，只搬 history 会留下 orphan backup，
  所以腾槽位从两件套升级为三件套（history + controller + backup 对）。
- `--archive` 工具本可覆盖 `/opt` 那部分，但 #201 的符号链接修复恰好在这个尚未发布的候选里，
  线上运行的仍是有 bug 的版本——**修复工具的前提是先发布，而发布又需要工具**，构成鸡生蛋。
  在该修复上线前，腾槽位只能手工守卫式搬迁。
- 建议后续单独提 PR：给公网 health 探针加上与 loopback 同等的有界重试（并补回归），
  使一次瞬时抖动不再作废整轮发布窗口。

# 2026-08-15：`/opt` 产物的有效上限是常驻 5，不是 8

- 第二次发布尝试在预检即以 `CLOUD_RELEASE_ARTIFACT_RETENTION_LIMIT` 失败，当时 `/opt` 的
  `laundry-desk.` 前缀条目是 6，而 `assertRoomForRelease` 写的是 `count >= 8`。
- 只读代码会得出「6 < 8 应当通过」的错误结论。运维手册其实已写明真实口径：
  **预检峰值 = 当前计数 + incoming + next**。`ARTIFACT_PATTERNS` 里确实存在
  `laundry-desk.incoming-<sha>-<token>.tar` 与 `laundry-desk.next-<sha>`，发布过程中 `/opt`
  会临时多出这两项，`6 + 2 = 8` 正好触顶。
- 因此 `/opt` 的有效上限是**常驻 ≤ 5**，不是 8。第一次尝试能越过这一关是因为当时常驻为 5；
  它失败后留下的 `laundry-desk.failed-<sha>` 把常驻推到 6，于是第二次连停写窗口都没进就被挡。
- 教训：这套发布链的留存判据不能只按单个 `assertRoomForRelease` 的字面阈值推断，必须按手册
  记录的峰值口径；四个集合（artifact / history / controller / backup）的实际余量分别是
  常驻 5、7、7、7。
- 一次失败的真实代价是四个集合各消耗一格：history +1、backup +1 对、`/opt` +1 树、
  controller +1。连续两次失败就会同时触及多个上限，且在 #201 的归档修复上线前只能手工腾。
