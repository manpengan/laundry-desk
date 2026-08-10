# ADR-37：Cloud Web-first 主交付线与剩余功能顺序

- 日期：2026-08-10
- 状态：**Accepted**
- 决策者：manpengan
- 前序：[ADR-36：云测试环境与完整柜台面公网暴露](2026-08-09-adr-36-cloud-test-environment.md)
- 执行计划：[ADR-36 后续 Cloud Web-first 1–4 交付计划](../superpowers/plans/2026-08-10-post-adr36-delivery-plan.md)
- 影响：交付阶段线、阶段验收、Linux Web 优先级、桌面/硬件优先级、外部提供商证据

## 背景

ADR-36 已按 2026-08-09 的裁决建立 `desk.manpengan.xyz` 合成数据云测试环境，并把
macOS Electron 柜台与 Runtime.app 移出每期关键路径。其后的计划却又把交付顺序改成
「macOS → XP-58 → 正式 macOS → Windows → 生产 SaaS → AI/迁移」，导致已被后置的
桌面与硬件门禁重新挡在 Web 功能开发之前。

2026-08-10，manpengan 进一步明确：**后续主要以云服务器部署的 Linux Web Server 为
主，在这一形态上开发和测试剩余功能；Windows 等桌面软件先不做，并按已盘点的 1–4
阶段依次完成。**

这项裁决把 ADR-36 从一次性的云测试插队提升为当前主交付线，但没有把 hk-vps 变成生产
SaaS，也没有授权真实顾客资料进入该环境。

## 决策

### 1. Linux Cloud Web 成为当前主交付与集成验收形态

从本 ADR 起，活动产品开发以以下组合为主：

```text
Browser → https://desk.manpengan.xyz → Caddy
        → loopback Fastify → loopback PostgreSQL 16
```

- React Web、Fastify、PostgreSQL、鉴权、命令/查询与审计是当前功能交付面。
- `workspace-check` 与 `real-postgres` 继续是 PR required checks；云环境不替代代码门禁。
- 一个阶段只有在目标 `main` SHA 精确部署、数据库到目标迁移头、远端 Web 行为与安全边界
  均有新鲜证据后才能关闭。云端暂时不可用不阻止普通 PR 合入，但阻止当前阶段宣称完成。
- 现有本地/桌面证据继续有效，但不再要求每个 Web 功能同步补 Electron、Runtime、CUPS 或
  操作系统安装验收。

本条修订 ADR-36 §6 的阶段判据：云行为从可选观察结果升级为 **Cloud Web 阶段关闭证据**；
GitHub required checks 的地位不变。

### 2. 剩余工作按 1–4 顺序交付

阶段必须依次关闭，不把后续大模块混入当前阶段：

1. **云端基线与既有 Web 收口**：固化本 ADR；精确部署目标 `main`；迁移到目标 schema；
   保持 PostgreSQL/Fastify loopback 与公网认证链；新增不会重置共享数据库的远端浏览器验收；
   建立受控、可审计、可清理的 30/90/180 天催取 fixture，关闭 ADR-36 Web 验收遗留项。
2. **柜台可信性缺口**：把折扣、附加费、急件费、运费与设置读取纳入服务端权威规则；补
   支付流水查询与双管理员退款 Web；补衣物颜色/品牌/瑕疵/附件/件级备注，以及挂单刷新后
   恢复。每个切片以真实 PostgreSQL、浏览器与新鲜云行为验收。
3. **经营增强**：依次补价目排序/重新启用/审计入口、Owner 公网经营与门店管理、会员
   等级/积分/次卡/券/有效期，以及顾客扩展档案。涉及新增命令或查询的切片仍须在实现 PR
   内附精确 ADR，不以本 ADR 的路线级授权替代 ADR-16 的契约冻结门禁。
4. **大型云端模块**：先补与主部署形态直接相关的备份、恢复演练、监控和联合回滚，再按
   独立 ADR 交付自动通知、店厂交接、取送、营销、顾客自助与 AI/BYOK。大模块之间仍按
   依赖拆成可验收切片，不做一次性横跨全栈的无边界实现。

计划文件记录每阶段的精确关闭条件和实时状态；本 ADR 只冻结顺序与边界。

阶段 1 首次发布的 `0045_store_commissioning_staff_credentials.sql` →
`0046_print_job_request_idempotency.sql` 被明确裁决为旧代码兼容迁移：0046 只增加 nullable
列、索引与受约束触发器，不删除或收窄 0045 已有读写面；旧服务写入仍由数据库派生正式幂等键，
历史歧义行保持 `NULL` 并失败关闭。因此该**精确迁移对**在候选切换失败时允许只切回旧代码，
但不得自动恢复数据库。后续任何新迁移都必须另行提供起止迁移头与 ADR 证据；不得继承本次
兼容声明。

阶段 1 的共享云库发布必须使用可恢复的持续写门闩，而不是一次性连接快照：停服后先把
`laundry_app` 原始 LOGIN 状态与 `intent` 写入 transition，再切为 NOLOGIN、终止现存应用会话，
直到候选切换成功或兼容回滚完成才恢复 LOGIN 并启动服务。迁移前后与 `finalize` 都必须按
PostgreSQL 16 和 migration head 绑定的 golden catalog policy 核对数据库安全面；每份保留的
dump/manifest 也必须由唯一 history 记录绑定并在后续发布前重新验摘要。未知迁移头、状态漂移、
备份缺失/复用/orphan 或不兼容迁移失败一律进入失败关闭，不以健康接口替代数据库证据。

### 3. Windows、macOS 正式发行与 XP-58 移出当前关键路径

以下能力保持已有代码与历史证据，但在 1–4 完成前均不作为当前阶段，也不阻塞 Cloud Web
功能开发：

- Windows 打包、安装、升级、卸载与真实主机适配；
- macOS Developer ID、notary、staple、Gatekeeper、正式双架构 OCI 与公开更新源；
- XP-58 中文、金额、条码、走纸、切刀、断连与补打实体证据；
- Electron/Runtime/CUPS 与每个新增 Web 功能的同步适配。

这不是取消上述工作。恢复其中任一项时，应按届时真实硬件、证书与操作系统形成独立阶段，
不得用当前软件测试、CI 或云行为回填正式证据。

### 4. 云测试安全边界保持失败关闭

ADR-36 §3–§5 继续生效：hk-vps 不安装 Docker，Caddy 复用既有 80/443，Fastify 与
PostgreSQL 只监听 loopback，公共入口保留精确 Host/Origin、Secure host-only Cookie、
Fetch Metadata、CSRF、认证、授权和限流。

在出现独立的生产云 ADR 与验收之前：

- 仅允许带唯一运行标识的合成数据，禁止真实顾客 PII；
- 数据仍可随时丢弃，不以当前主开发形态推导备份、SLA、容量或灾难恢复已交付；
- 远端浏览器或 fixture 不得复用会清空、覆盖共享数据库的本地 Playwright global setup；
- 证据不得包含密码、token、cookie、私钥、数据库口令、真实手机号或 provider secret；
- 部署不得破坏同机 `kb.manpengan.xyz`、Caddy 或其他既有服务。

### 5. 外部提供商完成声明必须有真实证据

短信、微信、支付机构、地图/配送、AI 模型和任何其他外部提供商分两层验收：

1. provider-neutral 状态机、outbox、幂等、重试、回执映射与失败降级，可以用严格 fake
   做代码门禁，但只能标记 `software_only`；
2. 「已接入」「已发送」「已到账」「已送达」或「AI 可用」只能在获授权的真实 sandbox
   或正式账号中，以独立密钥、限额/成本保护、真实请求、provider 回执/webhook、失败路径
   和撤销/回滚证据关闭。

缺账号、凭据、额度、模板审批、回调域名或用户授权时，相关集成标记
`blocked_external_provider`；不得提交秘密、用 mock 冒充提供商证据，或为绕过阻塞关闭安全
校验。

## 后果

- 2026-08-10 的「macOS/XP-58/正式发布/Windows/生产 SaaS/AI」1–6 计划由本 ADR 取代；
  历史 software-only 与硬件盘点结果仍保留，不改写为失败或完成。
- ADR-14 §4、ADR-16 §3 与 ADR-36 §1 中与当前顺序冲突的部分，以本 ADR 为准；V2-only、
  契约面 ADR 门禁和 ADR-36 公网安全代偿约束不变。
- 云端现在是功能阶段关闭必需的集成证据面，但仍不是生产 SaaS、真实门店数据载体或
  外部提供商完成证据。
- 每阶段仍须测试、提交、经 PR 合入 `main` 并确认 required CI 绿灯；再部署该 `main` 并
  完成远端验收，才能开始下一阶段。

## 否决的备选

- **继续等待 XP-58、Apple 凭据或 Windows 主机**：让外部资源阻塞已具备 Linux Web
  运行条件的功能开发，与本次裁决冲突，否决。
- **把 hk-vps 直接称为生产 SaaS**：当前仍是单机、合成数据、可丢弃环境，没有生产数据
  保护、容量、SLA 与事故运维证据，否决。
- **同时并行 1–4**：会让契约、迁移、UI、部署与验收边界失去可追溯性，否决。
- **用 fake/provider SDK 单测关闭真实集成**：无法证明账号、网络、模板、回执、费用与
  降级路径，否决。
