# ADR-36 后续 Cloud Web-first 1–4 交付计划

> 日期：2026-08-10
> 状态：**阶段 1、2 与阶段 3.1「价目治理」已关闭；下一顺序切片为阶段 3.2**
> 阶段 1 验收：[ADR-36 Web 产品收口验收记录](../specs/2026-08-09-adr36-web-product-convergence-acceptance.md)
> 阶段 1 结果：[hk-vps 阶段 1 发布结果](../../operations/2026-08-11-stage1-release-result.md)
> 阶段 2 验收：[柜台可信性验收记录](../specs/2026-08-11-stage2-counter-trust-acceptance.md)
> 阶段 2 结果：[hk-vps 阶段 2 发布结果](../../operations/2026-08-11-stage2-release-result.md)
> 阶段 3.1 验收：[价目治理验收记录](../specs/2026-08-11-stage3-catalog-governance-acceptance.md)
> 阶段 3.1 结果：[hk-vps 阶段 3.1 发布结果](../../operations/2026-08-11-stage3-catalog-governance-release-result.md)
> 当前裁决：[ADR-37](../../adr/2026-08-10-adr-37-cloud-web-primary-delivery.md)
> 继承边界：[ADR-16](../../adr/2026-07-31-adr-16-edge-operations-scope-ratification.md) · [ADR-36](../../adr/2026-08-09-adr-36-cloud-test-environment.md)

## 1. 目标与推进规则

后续以 hk-vps Linux Fastify/PostgreSQL + Browser Web 为主交付与开发测试形态，按 1–4
固定顺序补齐剩余功能。Windows、macOS 正式发行、XP-58 实体打印和逐功能桌面适配不在
当前关键路径。

推进规则：

1. 当前阶段先完成精确设计、实现和与风险相称的新鲜本地测试。
2. 测试通过后经 PR 合入 `main`，确认 `workspace-check` 与 `real-postgres` required checks
   绿灯；不得直接在服务器上开发或形成只存在于服务器的补丁。
3. 把该 `main` SHA 精确部署到 hk-vps，迁移到目标 schema，并完成公网 Web、loopback、
   服务端/数据库回读与安全边界验收后，当前阶段才算关闭。
4. 只有当前阶段全部关闭才开始下一阶段。外部账号、凭据或审批缺失时，相应项标记
   `blocked_external_provider`，不得用 fake 代替；不会依赖这些外部项的当前阶段工作继续完成。
5. 新增命令/查询或改变对外能力边界时，继续遵守 ADR-16：实现 PR 同批附精确 ADR、
   CHANGELOG 和受影响的验收记录，并点名 `m2-freeze.test.ts` 清单变化。
6. 云端只使用可追踪、可清理的合成数据；任何验收都不得记录秘密或真实顾客 PII。

## 2. 固定交付顺序

| 阶段 | 状态       | 范围                                                                                                                 | 关闭证据                                                                             |
| ---: | ---------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
|    1 | **已关闭** | 云端基线与既有 Web 收口：路线治理、目标 main 精确部署、schema head、公网安全浏览器验收、30/90/180 天历史催取 fixture | 2026-08-11 以 `7989206…28e` 完成 required CI、marker/schema、HTTP/Browser 与清理证据 |
|    2 | **已关闭** | 柜台可信性缺口：服务端权威计价与设置生效、支付流水/退款 Web、衣物详情与挂单刷新恢复                                  | `6f106076…3f47` 完成 PR/主干 CI、marker/0047、API 15/15、Cloud Chromium 与清理证据   |
|    3 | **进行中** | 经营增强：价目排序/重新启用/审计、Owner 公网经营与门店管理、会员等级/积分/次卡/券/有效期、顾客扩展档案               | 3.1 已按 ADR-39 关闭；下一顺序切片为 3.2 Owner 公网经营与门店管理                    |
|    4 | 待开始     | 大型云端模块：云备份/恢复/监控/联合回滚；自动通知；店厂交接；取送、营销、顾客自助；AI/BYOK                           | 每个模块独立 ADR/威胁边界/回滚；生产性声明另需容量、恢复或 provider 真实证据         |

## 3. 阶段 1：云端基线与既有 Web 收口（已关闭）

关闭结果：目标 `main` `7989206b3e9748b2a607687466ef2e0775ad528e` 已完成精确主干 CI、
hk-vps 两阶段发布、迁移 46/head `0046_print_job_request_idempotency.sql`、API 15/15 与只读
Cloud Chromium PASS；详见[阶段 1 发布结果](../../operations/2026-08-11-stage1-release-result.md)。

### 3.1 交付物

1. 以 ADR-37 修订路线真源，不回改 ADR-36 Accepted 正文；同步 README、ADR 索引、
   CHANGELOG、本计划与 ADR-36 验收记录。
2. 部署执行时解析目标 `main` 的完整 Git SHA；服务器 release marker、运行代码和验收记录都
   精确绑定该 SHA，不使用浮动的「最新版本」描述。
3. PostgreSQL 应用到该 SHA 的迁移头；Fastify/PostgreSQL 继续只监听 loopback，公网只经
   Caddy 80/443，认证、Host、Origin、Fetch Metadata、CSRF 与限流不放宽。
4. 新增专用公网 Playwright 配置与只读 `core_ui_subset`。它不得调用本地 E2E global setup、
   不得发出产品命令、下载文件、清库或覆盖 fixture；只验证正常登录后核心页面与既有数据的
   可达性，并断言命令请求数为零。它是独立 UI 证据层，不具备单独关闭阶段的权限。
5. 新增 opt-in 历史时间 fixture：只为本次 run 创建 30/90/180 天合成订单，记录受控的
   建立/核对/清理步骤，不关闭当天营业日，不直接改变既有业务数据。
6. 由 ADR-36 公网 HTTP acceptance 验证双管理员/员工、价目、开单/履约/收退款/取衣/交班、
   会员生命周期、催取/人工名单与账务导出，并由只读 `core_ui_subset` 验证对应核心 Web 页面
   可达。HTTP、UI、数据库/审计证据分层记录，任一层不得冒充另一层。

### 3.2 关闭条件

- 目标 SHA 的 `workspace-check` 与 `real-postgres` required CI 均绿。
- hk-vps marker 与目标 `main` 完整 SHA 一致，schema 与仓库迁移头一致。
- `laundry-desk`、`postgresql`、`caddy` 与同机 `kb-web` 健康；failed units 为零；监听、
  Caddy 与 KB 站点没有非预期变化。
- ADR-36 HTTP acceptance 不再有 `reminder_history BLOCKED`，安全清理后无本次 run 的临时
  服务器文件、活动会话、员工、价目、未关闭会员或未清理合成订单。
- ADR-36 HTTP acceptance 覆盖 §3.1 第 6 条的完整纵向并通过；浏览器
  `core_ui_subset` 只读通过且确认零产品命令。两者合并才构成公网 Web 证据；截图、日志和
  报告不包含秘密或真实 PII。
- [ADR-36 Web 产品收口验收记录](../specs/2026-08-09-adr36-web-product-convergence-acceptance.md)
  追加新目标 SHA 的证据，P2-1 至 P2-4 全部关闭。

## 4. 阶段 2：柜台可信性缺口（已关闭）

依次交付：

1. **计价与设置权威**：客户端只提交业务选择和允许的输入；服务端验证并计算折扣、附加费、
   急件费、运费和最终金额。设置必须可读回、可审计，并有实际业务消费者，不能只写不生效。
2. **支付流水与退款 Web**：提供门店/订单范围内的支付流水入口，让有权用户选择可退款
   原支付并发起受限退款；继续使用只追加账本、幂等、原因和另一管理员 step-up。
3. **衣物详情与挂单恢复**：补齐颜色、品牌、瑕疵、附件和件级备注；挂单刷新或重新登录后
   可由服务端状态安全恢复，不以浏览器内存作为真源。

三个切片分别关闭，不因 UI 出现按钮就宣称完成。金额、权限、并发和审计必须有真实
PostgreSQL 回归，公网 Web 需按正常操作旅程验证。

三个 checkpoint 已按 1→2→3 完成。PR #167、精确 merge SHA `6f106076…3f47` 的主干
Foundation/PostgreSQL、hk-vps `prepare → finalize`、47/head 0047、API 15/15、Cloud Chromium、
数据库/审计与清理复核均通过；具体身份见[阶段 2 验收记录](../specs/2026-08-11-stage2-counter-trust-acceptance.md)
和[阶段 2 发布结果](../../operations/2026-08-11-stage2-release-result.md)。本阶段不再承载新能力；
后续变更进入阶段 3 的独立 ADR/PR。

## 5. 阶段 3：经营增强

按以下顺序拆成独立 ADR 和 PR：

1. **已关闭：**价目排序、停用项重新启用与管理员审计入口；ADR-39、本地真实 PG、
   Chromium 17/17、PR/精确主线 CI、hk-vps marker/0048、API 15/15 与 Cloud Chromium 已通过；
2. **下一步：**Owner 公网只读/受限管理面、完整报表和授权门店管理；
3. 会员等级、积分、次卡、优惠券与有效期；
4. 顾客多地址、车辆/标识、服务偏好、免责声明与折扣政策等扩展档案。

每个切片先冻结数据归属、门店/组织作用域、角色权限、隐私导出/匿名化和历史快照语义。
Owner 公网化不得直接复用 ADR-26/27 的 LAN 假设；资金和优惠能力不得由客户端计算。

阶段 3.1 的精确候选为 `f276bdbf328ae20aba20c7985c690a63484afdca`，发布后 golden catalog
为 678 entries / `2b15ed36…052`，应用角色无 catalog DELETE/TRUNCATE 权限，公网 API 与
Browser、marker/schema、服务、清理及保留证据均已闭环；详见[阶段 3.1 验收记录](../specs/2026-08-11-stage3-catalog-governance-acceptance.md)
和[阶段 3.1 发布结果](../../operations/2026-08-11-stage3-catalog-governance-release-result.md)。

## 6. 阶段 4：大型云端模块

大型模块内部按以下顺序推进：

1. 云端 PostgreSQL + 私有照片一致性备份、离机保留、影子恢复演练、监控告警与代码/迁移/
   数据联合回滚；在这些证据形成前，hk-vps 仍是可丢弃开发环境。
2. provider-neutral 通知 outbox、幂等发送、重试、退避、回执和人工降级，再接短信/微信
   provider。
3. 店厂交接批次、清点差异、质检/返工与移动交接证据。
4. 取送、营销/券活动与顾客自助入口。
5. AI/BYOK 的权限投影、风险确认、成本上限、失败降级与密钥隔离。

阶段 4.4 当前按独立权威层推进：Item 1 门店策略、Item 2 顾客预约、Item 3 配送订单之后，
Item 4 由 [ADR-49](../../adr/2026-08-13-adr-49-authoritative-delivery-tasks.md)冻结配送任务分派、接单、
转派和人工接管；Item 5 由
[ADR-50](../../adr/2026-08-13-adr-50-mobile-delivery-task-h5.md)增加独立 `/mobile/tasks` 当前员工任务面，
不扩大 68/47 契约。照片/GPS/签名和其他交付证据仍留给 Item 6，不能在任务记录或移动客户端中提前
混入。

第 2、4、5 项若依赖外部平台，fake 只能证明 `software_only`。真实完成至少要求获授权的
sandbox 或正式账号、独立秘密、限额/成本保护、真实请求、provider 回执/webhook、失败与
撤销路径；缺任一项即标记 `blocked_external_provider`。

## 7. 明确后置的独立门禁

- Windows 打包与真实主机安装/升级/卸载/打印；
- macOS Developer ID、公证、staple、Gatekeeper、正式双架构 OCI 和公开更新源；
- XP-58 中文、金额、条码、走纸、切刀、断连/恢复和补打；
- 每个新增 Web 功能的 Electron/Runtime/CUPS 同步适配；
- v1 真实数据迁移。

历史 [macOS Web 产品面对齐验收](../specs/2026-08-10-macos-web-product-parity-acceptance.md)、
[XP-58 实体打印验收](../specs/2026-08-10-xp58-physical-print-acceptance.md)和正式候选证据继续
有效，但只证明各自记录的层级。恢复这些门禁时另立当前计划，不回填 Cloud Web 证据。

## 8. 历史计划关系

本计划由 ADR-37 修订 2026-08-10 早先的 macOS/XP-58/Windows 1–6 顺序；旧阶段 1 的
software-only 绿灯与旧阶段 2 的硬件盘点仍是历史事实，不作为当前阻塞。

[ADR-36 Web 产品收口计划](2026-08-09-adr36-web-product-convergence-plan.md)与其验收记录成为
阶段 1 的既有 Web 基线子计划；历史 `ae9808c` 证据保留，新目标 `7989206…28e` 已在验收与
发布结果中独立记录。
