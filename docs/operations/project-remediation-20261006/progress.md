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
