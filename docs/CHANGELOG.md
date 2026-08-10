# Changelog

本项目版本记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。

> **当前路线（2026-08-10 修订）**：[ADR-37](adr/2026-08-10-adr-37-cloud-web-primary-delivery.md) 将 hk-vps Linux Server/Web 确定为当前主交付与开发测试形态，后续按 [Cloud Web-first 1–4 交付计划](superpowers/plans/2026-08-10-post-adr36-delivery-plan.md)依次完成云端基线、柜台可信性缺口、经营增强与大型云端模块。Windows、macOS 正式发行、XP-58 与逐功能桌面适配移出关键路径；外部提供商完成声明必须有真实 sandbox 或正式回执。[ADR-13](adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md) 的 V2-only 基础、契约面 ADR 门禁及 ADR-36 公网安全边界继续有效。

---

# v2 线（通用本地优先产品）

## [Unreleased · v2]

_本节记录**面向用户的变化**；纯内部重构与验证性工作不入 CHANGELOG，去向见 `docs/research/` 与 `docs/superpowers/plans/`。_

### 新增

- Cloud Web-first 后续路线（[ADR-37](adr/2026-08-10-adr-37-cloud-web-primary-delivery.md)）：Linux hk-vps Web 成为当前功能开发与阶段集成验收面；四阶段依次收口现有云端基线、柜台可信性缺口、经营增强与大型云端模块。每阶段仍须 `workspace-check`/真实 PostgreSQL 门禁、PR 合入 `main`、精确部署该 SHA 与公网 Web 新鲜证据；hk-vps 仍只允许合成数据且不等于生产 SaaS。Windows、macOS 正式发行与 XP-58 保留为后置独立门禁；provider fake 只能标记 `software_only`。

- 新增 hk-vps 两阶段发布入口：候选必须是 required CI 双绿的 exact clean `main`，实际 SSH/SCP 固定本轮 Ed25519 authority；迁移窗口以 transition write-ahead 记录和 `laundry_app NOLOGIN` 持续阻断业务重连，只有恢复 LOGIN 并持久化 released 后才启动服务。发布会建立 root-only database dump，使用同集群 shadow restore 比较完整迁移账本，并按 PostgreSQL 16 + migration head 绑定的 golden policy 核对 owner/ACL/RLS/policy/function 与 cluster/bootstrap catalog；后续 preflight 又从 history 精确重验每份 dump/manifest，拒绝缺失、篡改、复用和 orphan。`finalize` 会亲自运行远端 API acceptance 与本地公网 Chromium 只读子集，把两份版本化结果绑定到 candidate、旧 SHA、迁移头和 transition 后才允许提交；缺失、过期、清理失败或 identity 漂移均失败关闭。每轮另保留与候选、归档和 transition 摘要绑定的 root 私有版本化回滚控制器，切换前后及 live rename 崩溃窗口都不依赖可交换的应用目录。该入口尚须在合并后用精确目标 SHA 形成实际部署证据。

- ADR-36 acceptance 新增仅限 hk-vps 测试环境的 30/90/180 天合成催取 fixture，以及固定 `desk.manpengan.xyz`、零产品命令的 `core_ui_subset` Playwright 配置；required `real-postgres` 同时新增发布 catalog 真库探针。HTTP 完整业务纵向、浏览器读面和数据库恢复证据继续分层，不互相冒充。

- macOS 当前 Web 产品面对齐验收：同一真实 PostgreSQL/Server 上的 Browser 17/17 与打包 Counter 7/7 已新鲜通过，覆盖柜台工作日、件级履约与照片、会员资金与生命周期、隐私治理、催取/账务/交班 CSV、离线恢复、设置和本机 CUPS 配置；全新 macOS 投产流程 1/1 通过，并验证员工密码与 PIN 重置前后的新旧凭据切换。验收记录见 [macOS Web 产品面对齐验收](superpowers/specs/2026-08-10-macos-web-product-parity-acceptance.md)。证据标记为 `software_only`，不等于 XP-58 出纸、Developer ID/公证、正式 OCI、Windows 或生产云验收。
- 新增 Runtime.app → 真实 Server OCI → 打包 Counter 的托管 loopback 组合验收入口，已新鲜覆盖安装、健康检查、停止/启动/重启、Counter 固定桥接与失败路径清理，并输出 `RUNTIME_COUNTER_LOOPBACK_ACCEPTANCE_OK assurance=software_only runner=system ... cleanup=clean`。该结果只证明本机软件组合，不等于正式发布或外部硬件证据。

- hk-vps 云测试环境（[ADR-36](adr/2026-08-09-adr-36-cloud-test-environment.md)）：新增与 `LAUNDRY_LAN_ORIGIN` 互斥的 `LAUNDRY_PUBLIC_ORIGIN`，只接受默认 443 的精确公共 HTTPS 域名；它启用 Secure host-only Cookie 与 same-origin Fetch Metadata，但不放宽 ADR-32 的私网 IPv4 LAN 约束。`desk.manpengan.xyz` 由 Caddy 反代 loopback Fastify，PostgreSQL 16 只监听 localhost，完整柜台写面仍受既有认证、CSRF、Host 与 Origin 门禁保护。部署、回滚、版本标识和双站维护流程见 [hk-vps 运维手册](operations/2026-08-09-hk-vps-cloud-test.md)。

- 独立 loopback PostgreSQL 16 与 Fastify 生命周期，包含迁移、一次性 bootstrap、持久卷保护和真实数据库就绪门禁。
- 浏览器与 Electron 共用同一 React SPA；桌面端只暴露固定的认证、命令、查询与健康能力，令牌和 cookie 留在主进程。工作区门禁会先构建当前 Web 再只读核对已提交 SPA，落后时直接失败。
- 通用 `laundry-desk V2` 柜台 Electron macOS 未签名本地测试包与隔离验收链；不包含 DMG、Developer ID 签名、公证、自动更新、云部署或 Windows 适配。
- 开单与权威计价：按件选服务与品类，支持折扣、加急、附加与运费；金额全程整数分，计价以服务端为准。
- 收款与欠款：现金/微信/支付宝/其他多方式收款，支持部分收款留欠款、独立欠款补缴与退款，支付流水只追加。
- 挂单与撤销：未结订单可挂起或撤销，危险操作走统一二次确认。
- 取衣：整单或按件部分取衣，取衣时可直接补收尾款。
- 顾客：按手机号建档与去重，支持手机号、姓名前缀与取件码统一查找。
- 营业日、统计与交班：以门店时区归属营业日，提供当日统计、CSV 导出与交班结账。
- 柜台界面：三栏工作台与三栏开单页，含订单列表/详情抽屉、取衣页、欠款页、统计页与交班面板。
- 局域网 Owner Dashboard（[ADR-26](adr/2026-08-07-adr-26-lan-owner-dashboard.md)）：新增独立 `/owner` 手机响应式只读入口，管理员可查看今日营业额（业绩/实收双口径）、取衣件数、新增欠款、满 30 天滞留件，以及同一权威快照的 7/30 日趋势，并可显式注销共享终端会话。查询不接收客户端租户、门店或日期，不进入 AI 投影；PostgreSQL 与 Fastify 继续只暴露在回环地址，局域网仅开放显式私网地址上的同源 HTTPS 网关，使用 Secure host-only Cookie 并拒绝跨站 Origin、错误 Host 与一切转发头。本片不含云访问、跨店汇总、写操作或正式公网证书托管。
- Owner 运营下钻与授权门店对比（[ADR-27](adr/2026-08-08-adr-27-owner-drilldown-portfolio.md)）：取衣、新增欠款和滞留件三张卡可查看最多 50 单的脱敏明细，完整汇总继续与首屏同口径；门店组合视图只汇总当前员工在该店仍为 active admin 的最多 50 家门店。两条查询都不接收客户端组织、门店、日期或行数，不返回顾客资料、内部 UUID、条码或架位，并逐店在 PostgreSQL RLS 下重新证明权限。
- LAN 设备接入与诊断（[ADR-28](adr/2026-08-08-adr-28-lan-onboarding-diagnostics.md)）：新增只包含 `/owner` 地址的终端二维码、叶证书指纹和 iOS/Android/macOS 人工信任指引；诊断会有界检查证书有效期、IP SAN、密钥匹配、回环 Server、受信 HTTPS 和 8787/8543 未暴露。工具不生成或安装证书，不输出密钥路径、响应体、异常详情或凭据；网关仍只允许固定的 Owner 只读代理面，不开放任意路由。
- Runtime.app 托管备份与恢复（[ADR-29](adr/2026-08-08-adr-29-runtime-managed-backup-restore.md)）：原生主机管理器可在私有目录创建、列出、验证并恢复 PostgreSQL + 照片一致性备份；严格 manifest 绑定实例、版本、schema、大小和 SHA-256，恢复前要求摘要确认并自动创建预恢复安全点。该能力不进入柜台 Electron、Owner LAN、Fastify API、命令总线或 AI；本地 ad-hoc/no-repo 验收不等于 Developer ID、公证或换机分发完成。
- Runtime.app universal 发布与受控升级（[ADR-30](adr/2026-08-08-adr-30-runtime-release-upgrade-rollback.md)）：原生 App 同时构建 arm64/x86_64，并提供固定参数的 release/manifest 工具链。升级只接受签名候选，精确绑定当前回滚目标，先创建 PostgreSQL + 照片安全点再迁移和健康验收；失败自动恢复旧版本。升级/回滚元数据以单一严格 transition 绑定切换前后状态，在任一原子写后进程中断，重启也会在普通严格加载前恢复安全点并回到稳定版本。显式一步回滚要求 stdin 摘要确认，恢复升级前快照并保留回滚前数据安全点；历史最高已接受版本阻止继续向旧安全版本降级。Developer ID、公证、正式签名权威、公开更新源和已发布 OCI 仍需外部证据。
- 新店双管理员投产与员工凭据生命周期（[ADR-31](adr/2026-08-08-adr-31-store-commissioning-staff-credentials.md)）：全新 Runtime 安装在一个 owner 事务中建立两位凭据相互独立的管理员、当前本地 feature profile、永久投产标记和无秘密审计；旧单管理员卷只能通过 Runtime 的一次性维护入口补齐，柜台 HTTP 不获得 owner 权限。日常员工创建和凭据重置走 R5 命令、另一位管理员复核与持久幂等，原始密码/PIN 仅进入 creator-bound、限速、CSRF 保护的专用完成边界。Browser 与打包 macOS 的独立空卷验收均从真实 bootstrap 开始，不依赖 E2E SQL。
- 设备本地 CUPS 打印配置（[ADR-34](adr/2026-08-08-adr-34-device-local-cups-printer-configuration.md)）：打包柜台 App 的管理员可在 Settings 发现、选择、停用本机已安装的安全队列，并显式提交不接受自定义正文的固定测试票。选择以私有原子 v1 文件持久化，旧 `LAUNDRY_CUPS_QUEUE` 仅首次验证迁移；主进程串行停止/启动签名打印 controller，并在每次 claim 前复核队列。Renderer 不获得路径、argv、raw bytes、generic shell 或 claim/receipt。`uncertain` 现在在队列面明确提示可能已出纸，只能检查纸张后手动重试；CUPS 接单与软件 fake 门禁仍不等于 XP-58 实体验收。
- Runtime.app 托管 LAN 运维（[ADR-32](adr/2026-08-08-adr-32-runtime-managed-lan-operations.md)）：无仓库的原生入口可配置、启停、查看状态、生成接入卡、诊断局域网 Owner HTTPS，并创建不超过 256 KiB 的脱敏支持包。manifest v2 同时绑定 LAN overlay 与内嵌 Owner SPA；gateway 复用签名 Server OCI，固定 healthcheck 严格验证 CA、公开 IP 身份和 Host，`disable` 不停止回环 Server，直接重启或重新配置后启用均有生命周期门禁。required macOS CI 现用单次 universal build 连续覆盖原 Runtime 与 LAN no-repo 验收；真实容器/物理 LAN 验收保留为本机最终门禁。Developer ID、公证、正式 OCI 签名和第二台真实设备证书安装仍需外部证据。
- 可携带正式候选证据（[ADR-35](adr/2026-08-08-adr-35-portable-release-candidate-evidence.md)）：新增 release/field 两层严格双签信封，统一绑定 Git/版本、Counter 与 Runtime App/DMG/ZIP/签名 manifest、OCI 原始 index、真实容器换机报告、第二台 Mac 和 XP-58 记录；universal 原生验证器可在无仓库、Node、pnpm、PATH 与 cwd 状态下离线复核。测试构建统一标为 `software_only`；缺 Developer ID、公证、正式权威、公开 OCI 或任一实机报告时正式模式失败关闭，当前不宣称这些外部材料已经取得。

> **ADR-14 首个里程碑「本地单机完整柜台工作日」已达成**，逐条验收口径、证据与覆盖层见[里程碑 1 验收记录](superpowers/specs/2026-07-29-milestone-1-local-workday-acceptance.md)。服务端走真实命令总线覆盖开单 → 补款 → 取衣 → 交班；同一套工作日（录价目 → 开单收部分款 → 取衣补齐结清）在浏览器与 macOS 打包应用中各跑通一遍，macOS 侧经 `pnpm local:acceptance` 本地验收（CI 只跑 Linux）。柜台 Electron 产物仍是未签名未公证的本地测试包；独立 Runtime.app 的软件与 ad-hoc/no-repo 门禁已交付，但正式发布门禁见下文。

- 价目维护（[ADR-15](adr/2026-07-28-adr-15-catalog-maintenance-unfreeze.md)）：设置页可新增价目、改价与停用；停用只下架不删除，历史订单的价格快照不受影响。仅管理员可改价。
- 模拟打印：打印任务渲染成 UTF-8 文本落盘，柜台可看到 queued/printing/done/failed 并重试或补打；产物可经鉴权按任务 id 下载，下载前与记录的哈希校验。本地栈已默认开启，无需额外配置。产物目录有单份大小、总量与份数上限，超出时按最旧优先淘汰；该目录随本地栈容器生命周期存在，`local:down` 后回收。

> 此前全新安装无法开单——价目表没有种子数据，契约面又只有价目查询没有写入命令，只能绕过应用直接写库。价目维护补齐后，全新安装的可用路径为：登录 → 设置页录入价目 → 开单。

以下能力按 [ADR-16](adr/2026-07-31-adr-16-edge-operations-scope-ratification.md) 并入当前阶段（原属 ADR-14 §4 的后置项）：

- 衣物照片：缩略图与原图查看、删除（带审计）、幂等上传与安全重编码；上传剥离元数据并校验文件头与哈希。
- 件级履约：单件与批量流转加工状态，支持返工、异常与丢损登记，每一步进审计。
- 货架与取衣：衣物上架到货架位，取衣支持扫码定位。
- 顾客治理：资料编辑、重复档案合并、隐私脱敏与资料导出。
- 员工权限：按门店维度分配员工权限，改权限需二次身份校验（R5 step-up）。
- 签名小票打印软件链：真实 PostgreSQL 权威快照经一次性 capability 派发，Edge 验签并渲染 ESC/POS，经 macOS CUPS 提交后签名回执结算；支持队列发现、验证与显式试打。**XP-58 尚未接入做中文、金额、条码、走纸与切刀实体验收。**
- 断网可用：柜台操作在断网时进本地加密队列（密钥经系统 Keychain 保管），恢复联网后回放；同一时刻只有一个实例持有主控租约，冲突可在界面处理。
- 本地数据保护：PostgreSQL 与私有照片绑定为可校验的恢复集，提供自动维护、恢复演练与只读诊断；恢复前校验实例、卷、摘要与权限，失败则保持原服务不动。
- 断网恢复与对账：恢复联网后离线操作经签名重放仲裁回放，重复与冲突可在界面处理；提供日结对账与导出。
- 普通 offline grant：六项低风险命令使用独立持久序号排队，恢复联网后由 PostgreSQL 在业务事务内做顺序、防重、权限与吊销复核；Primary 高风险命令仍走独立 lease。
- 会员储值（[ADR-17](adr/2026-07-31-adr-17-member-stored-value.md)、[ADR-18](adr/2026-08-01-adr-18-stored-value-settlement-reporting.md)）：顾客可开通会员账户预存金额，并用余额结账。余额在本组织所有门店通用；账本只追加，余额是流水之和而非可改字段，改错只能靠冲正而不能编辑。充值走现有线下收款方式，收银台的支付方式里**没有**「余额」——余额只能通过专门的余额结账扣减，避免出现没有扣款记录的收款。余额不足时拒绝结账，不允许透支。
  储值核销在日结对账中**单列一行**，与现金流入分开；它计入营业额但不计入当日现金，因为钱在充值当天就已收进店，交班的钱箱核对不受影响。
  收款与补缴对话框在顾客有可用余额时多出「会员余额」一项；选中后走专门的余额结账，扣款与本单支付在同一事务内完成，金额受订单欠款与可用余额双重限制。
  **ADR-17 首期当时不含**：充值赠送与分档、积分、微信支付对接、提现与储值退款、余额有效期；这是一条历史切片边界，不是当前待办清单。赠送与本金退款已由 ADR-22 后续交付；当前仍后置积分、支付机构接口、任意提现与余额有效期。储值操作一律不支持离线。
- 充值赠送与分档（[ADR-22](adr/2026-08-01-adr-22-member-stored-value-phase-2.md) §2、§3）：管理员可维护「充满 X 送 Y」的档位，充值时自动按命中的最高档位赠送。档位是满额档而不是比例——「充 1000 送 100」可以直接印在台卡上，也不需要定取整规则。档位对全组织生效，因为余额本身就跨门店通用。停用档位只下架不删除，且**不会重估已经发生的充值**：每笔充值都记下当时命中的是哪一档。赠送额一律由服务端计算，收银台无法自行指定。赠送不计入当日现金（顾客没有为它付钱），消费时**先扣赠款后扣本金**。改档位需要单独的管理员权限，不跟改价目共用。
- 储值退款（[ADR-22](adr/2026-08-01-adr-22-member-stored-value-phase-2.md) §4、§5）：顾客要求退卡时，可退的是**尚未消费的本金**，赠款不退现也不折现。可退金额不需要翻账：消费一律先扣赠款，所以剩下的本金恰好就是顾客自己没花掉的那部分。**不追扣已经享受过的赠送**——充 1000 送 100、只消费 100 的顾客仍可退回全部 1000 本金。退款需要管理员的专门权限与二次身份校验，必须填写理由，且金额受剩余本金限制、不允许退成负数。现金退款计入当日现金流出，交班能对上。
- 会员二期本地 Web 柜台入口：设置页可新增、编辑和停用充值赠送档位；客户会员面板展示可退本金并提供退款入口，退款仅向管理员开放，必须填写金额、渠道和原因，再由另一位管理员现场 PIN 复核。所有确认续跑只提交服务端冻结的 `confirm_ref`。充值 R3 首跳现同时冻结并展示精确本金、赠款、总入账及命中档位；首跳后即使管理员调档，确认续跑仍按冻结值入账，客户端不能重算或回传赠款。本片验收以 Linux 本地 Server、真实 PostgreSQL 与 Web 浏览器为准，macOS App 打包验收后置。
- 会员账户生命周期（[ADR-25](adr/2026-08-07-adr-25-member-account-lifecycle.md)）：Linux 本地 Web 可将活动账户挂失冻结，并由管理员受权解冻；冻结账户拒绝充值、余额消费和普通退款。关户是不可拆分的 R4 资金事务：锁内复核顾客、状态版本与本金/赠款快照，退回全部剩余本金，追加 `bonus_forfeit` 清零全部剩余赠款，再把账户永久置为 `closed` 并同事务审计。冻结、解冻与关户一律在线执行；实体卡、积分、有效期、双方都有会员账户的自动合并、重新入会和支付机构接口继续后置。macOS App 不因本片恢复开发或验收。
- 催取工作台与人工通知名单（[ADR-23](adr/2026-08-07-adr-23-pickup-reminder-manual-list.md)）：Linux 本地 Web 可按 30/90/180 天、衣物状态与欠款筛选当前门店未取订单，最多勾选 50 单，经 R3 冻结确认后按订单或顾客生成带 SHA-256 的 CSV 并复制号码。服务端在事务内重新锁定、复核候选，并只追加保存订单、批次和摘要证据，不留存手机号、话术正文或 CSV。该能力明确是人工降级路径，短信、微信、定时任务与任何自动发送仍未接入，生成名单不代表已经联系或送达；本片只验 Linux 本地 Server、真实 PostgreSQL 与 Web 浏览器，macOS App 验收后置。
- 经营账目双口径（[ADR-24](adr/2026-08-07-adr-24-accounting-dual-basis-reports.md)）：Linux 本地 Web 新增今日、往日、月结与职员报表。「实收」按非余额订单净收加充值/退款本金归集，「业绩」按全部订单支付净额归集并包含会员余额核销，避免充值与消费重复计算。报表固定按五种渠道展示，日期区间最多 366 天，支持带 SHA-256 完整性校验和只留摘要审计的 R3 CSV 导出；查询显式限定会话门店，同组织其他门店流水不会混入。ADR-24 当时不含老板 H5；后续 ADR-26 已复用同一口径交付单店局域网只读首屏，AI 分析、云端多店汇总与 macOS 验收仍未包含。
- macOS Runtime：交付独立 universal 原生 Runtime.app 软件，固定管理本地 PostgreSQL/Server 的 install/start/stop/restart/status/diagnose/launchd、同一签名 manifest 的中断安装恢复、ADR-29 托管备份恢复及 ADR-30 的 N→N+1/一步回滚；native acceptance 脱离仓库和宿主 Node。当前测试 App 只做 ad-hoc codesign 并信任临时测试 key。**Developer ID/公证、正式 manifest 签名权威、已发布双架构 OCI 与第二台无仓库 Mac 仍未形成外部证据。**

### 修复

- 修复打包 Counter 的小票按钮向严格 `print.ticket.enqueue` 投影多传 `ticket_no`、导致真实签名打印任务无法入队的问题；有桌面入队能力时，成功或失败都不再旁路调用浏览器 `window.print()`，并阻止重复点击产生多份任务。打印队列现向操作员显示验收 CLI 所需的 `job_id`，不显示订单内部 ID 或顾客资料。
- 签名打印请求现由 PostgreSQL 派生租户内精确幂等键：原始订单/票种重放与同一 source job 的 retry/reprint 都回读同一权威任务，覆盖刷新、跨客户端和 COMMIT 后响应丢失；历史歧义重复组与伪造 lineage 继续失败关闭，不会生成第二张实体票据。
- macOS XP-58 验收记录升级为 schema v3：必须由已上传设备签名回执绑定 `enqueue → reprint → retry` 的原始成功、断连失败/不确定和恢复后显式补打一份三个不同任务，同时记录 XP-58 型号、连接方式与打包 App 的 `app.asar`、SPA manifest、`Info.plist` 身份和版本摘要。当前 Mac 未发现可用 CUPS、USB 或局域网 IPP 打印机，因此该变化只关闭软件证据缺口，不宣称实体打印通过。
- 补回 Desktop 对既有 `platform.settings.set` 命令的契约投影，使打包 Counter 的 R5 设置保存继续经过主进程 schema 校验并正确转发；此前 Web 可用的设置写入在打包应用内会被拒绝为未支持命令。

- 修复主机 PostgreSQL 迁移与 RLS smoke 在连接失败时可能因 EXIT trap 丢失局部变量而遗留
  0600 临时 pgpass 文件的问题；失败路径现稳定清理，hk-vps 裸机迁移显式绑定 loopback 5432。
- 升级 Electron、Electron-Vite/Vite、React Router、PostCSS 及安全传递依赖，当前依赖审计不再包含 high/critical 告警；仅保留两个经调用路径证明不可达并由精确门禁锁定的 moderate 上游告警。

- 修正 `orders` 与 `payments` 的 `business_date` 约束正则（`\\d` → `\d`）。此前该约束拒绝任何合法日期，导致真实 PostgreSQL 上开单与收款全部失败。**已存在的本地数据库需要执行 `pnpm local:reset` 重建**，迁移校验和账本会拒绝直接复用。
- Electron 壳重新同步 `apps/web` 构建产物；此前柜台 UI 变更未回灌，壳内仍是旧版 SPA。
- 修复会员充值首跳命中 R3 确认后没有携带冻结 `confirm_ref` 续跑的问题；充值按钮现在能完成二跳并重新读取权威余额。
- 修复 Web 对账仍按四种付款方式解析结果的问题；`balance` 现在按 ADR-18 单列为「会员余额」，不再把合法对账响应误报为无法解析。
- 修复本地 Web/macOS 运行时漏接会员命令与查询的问题，并为店长、店员补齐顾客读写权限；打包应用现可完成开户、充值和余额支付，而不再返回“未注册命令/查询”。
- 修复真实 PostgreSQL 日结对账未把 `balance` 纳入服务端付款方式集合的问题；会员余额支付现在能进入权威对账快照。
- 顾客隐私导出与匿名化现已覆盖签名打印快照：排队中或打印中的快照会阻止匿名化，终态快照在同一事务内单向清除 JSON，原摘要与设备回执继续作为不含直接身份信息的审计证据。
- 普通 offline grant 高水位改由 PostgreSQL 强制从 0 开始且逐一递增；完全相同的打印回执在设备后续撤销或换钥后仍可读取已结算结果，不再破坏精确幂等重送。
- 修复管理员柜台在另一设备持有 Primary Lease 时连普通 offline grant 也拿不到，以及 Primary 续租失败会误废弃现有 grant 的问题。柜台现在先取得普通 grant，再 best-effort 申请 Primary；低风险离线命令仍可排队，Primary-only 命令、跨会话、过期与单调时钟异常继续失败关闭。软件打印验收也不再申请并不需要的 Primary。
- 修复现金充值不计入当日现金、交班必然长款的问题（[ADR-22](adr/2026-08-01-adr-22-member-stored-value-phase-2.md) §1）。此前充值的收款方式只写进审计记录，账本里没有这一列，统计与交班也从不读会员账本——顾客用现金充 1000，抽屉实收 1000，交班的期望现金却不含它，账面上没有任何地方能解释这笔长款。现在充值的收款方式落库，现金充值按**本金**计入当日现金（赠款是账面赠与，没有对应纸币，不计入）；微信/支付宝/其他充值与余额核销都不影响钱箱。**升级前已存在的充值记录无法追认收款方式，一律不计入现金**，因此历史交班记录不受影响。
- 修复会员充值 R3 确认只显示本金与渠道、无法核对精确赠款的问题。服务端现在在首跳计算并冻结本金、赠款、总入账和命中档位，摘要与冻结参数共同参与确认哈希；缺失或伪造冻结权威会失败关闭，Web 与 Desktop 只展示服务端摘要。

---

# v1 线（宏发单店版，Archived / 已归档）

> 以下仅记录历史实现，不再继续开发、补 tag 或独立发布。需要数据升级时由 `tools/migrate-v1` 只读消费。

## [0.3.0] — 历史未发布实现

### 新增

- 收件拍照：1–3 张，存 `userData/photos/YYYY-MM/`，订单详情可查看
- 58mm 热敏打印：登记单 / 取件条，`PrinterDriver` 抽象接口（ESC/POS 通用）
- 自定义 `media://` 协议安全加载本地照片（含路径穿越防护）

## [0.2.0] — 历史未发布实现

### 新增

- 价格模板与按件计费、折扣
- 付款方式（现金/微信/支付宝/刷卡/挂账）与欠款、取件时补收尾款
- 日/月营业统计与图表（Recharts）、逾期未取列表
- Excel 导入导出（exceljs）

## [0.1.0] — 历史未发布实现

### 新增

- Electron + React 19 + TypeScript strict + Tailwind 4 项目骨架（electron-vite）
- 收件登记 / 取件查询 / 订单列表 / 订单详情 / 客户管理 / 设置页
- 客户按手机号自动去重；4 位取件码（当日池，事务内冲突重试）；`YYYYMMDD-NNNN` 订单号
- SQLite（better-sqlite3 + Drizzle ORM，WAL）；金额整数分存储
- 每日 03:00 自动备份（WAL checkpoint + zip 滚动保留 30 份）+ 手动备份/还原
- IPC 全量 Zod 校验 + 统一 `{ ok, data } | { ok, error }` 信封；`sandbox` / `contextIsolation` / CSP
- GitHub Actions `windows-latest` 构建 + NSIS 安装器 + SHA256
