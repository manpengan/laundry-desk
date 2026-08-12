# 阶段 4.2 Provider-neutral 通知 outbox 验收记录

> 日期：2026-08-12
> 状态：**本地 software-only 实现与独立复核已完成；真实 provider 被外部条件阻塞**
> 决策：[ADR-44](../../adr/2026-08-12-adr-44-provider-neutral-notification-outbox.md)
> 基线：未提交 Stage 3.2–4.1 工作树；`main=origin/main=1c25dfd4423bb9033673e47bc058158086929407`

## 1. 范围

本记录覆盖管理员显式入队后的 provider-neutral 模板、outbox、租约、幂等发送、退避、回执映射、
成本上限、隐私门禁和 ADR-23 人工降级。它不包含无人值守受众选择、营销群发、真实短信/微信账号、
支付、店厂交接、取送、自助入口或 AI/BYOK。

## 2. 关闭矩阵

| 层级               | 关闭目标                                                           | 当前状态                   |
| ------------------ | ------------------------------------------------------------------ | -------------------------- |
| ADR/Contracts      | 1 command + 3 queries、53/36、R3→R4、online-only、非 AI            | 已冻结                     |
| Schema/RLS         | 0052 模板/批次/delivery/attempt/receipt、RLS、状态/费用/隐私约束   | 完成                       |
| Server             | 双后端 store、worker lease、fake adapter、receipt、manual fallback | 完成                       |
| Web                | capability/banner、入队确认/step-up、批次状态与人工降级            | 完成                       |
| PostgreSQL         | apply/replay、并发 claim、隐私竞态、回执乱序、成本/重试故障注入    | 完成；ADR-44 1/1           |
| Browser/Cloud      | 合成号码、software-only fake、无虚假发送/送达文案                  | 完成；功能 3/3、Cloud 接线 |
| Workspace/Security | format/lint/typecheck/test/build、独立安全与数据库复核             | 完成；P0/P1/P2 为 0        |
| External provider  | secret、模板审批、额度、真实请求、签名 webhook、失败/撤销          | 阻塞                       |

## 3. 不可替代的证据

- fake adapter 通过不等于短信/微信已接入；状态只能是 `software_only`。
- provider 返回 2xx 不等于顾客已收到；只有验签后的真实回执可形成 external delivered。
- outbox 行存在不等于发送成功；必须区分 queued/sending/accepted/delivered/manual_required。
- 单元测试中的重复 key 不等于 provider 真正支持幂等；真实 sandbox 必须证明响应丢失重试不会重复计费。
- hash/HMAC 不是随意保存 PII 的许可；新表仍不得保存手机号、消息正文或 provider payload。
- 本地 PG/Browser 不能替代真实 callback 域名、TLS、模板审批、账号额度和告警证据。

## 4. 当前外部边界

- 本轮未获得 provider 凭据、模板审批、费用额度、callback 域名或真实外联授权。
- 未获得 commit、push、PR、merge、hk-vps 部署或公网 webhook 变更授权。
- 本地实现完成后标记 `software_only` / `blocked_external_provider`，ADR-23 人工名单保持可用。

## 5. 当前本地证据（2026-08-12）

- 全新隔离 PostgreSQL 从空卷完成 52 个迁移、commissioning、0052 apply/replay、并发 claim、费用、
  重试、回执、RLS/GUC 和匿名化竞态；ADR-44 真库 1/1，release catalog 验证 0051→0052 write gate，
  0052 catalog 为 1116 entries，摘要为
  `de12b2776d5284245d2dbe570e74f50572e8cf4cf8952239bcba8506bfbe1311`。
- fresh Browser 完成空卷投产 1/1，以及会员、顾客档案、通知批次 Chromium 3/3。通知旅程以合成
  号码验证 R3 确认、软件队列、零成本、安全详情和“模拟已接单（未发送）”，自动通知面不返回号码
  或消息正文，也未出现“已发送/送达/通知成功”。
- Cloud API acceptance 增加只读 capability/batch/detail、PII 字段负向输入和未证明 external provider
  失败关闭，machine evidence 升为 v5；Cloud Chromium 子集只读验证 disabled/software-only banner，
  保持零产品命令。共享 Cloud 验收不创建无法安全删除的 append-only 通知证据。
- `pnpm workspace:check` 从依赖审计开始完整通过：high/critical 为 0，format、9 个包的 lint/typecheck、
  全部测试、Cloud 验收和构建均为绿。核心计数为根门禁 278/278、Contracts 785/785、DB 74/74、
  Web 392/392、Server 865 通过 + 86 个留给 fresh-PG 的 skip、Cloud 272 通过 + 1 个 Linux-only
  flock skip；Edge SPA 校验和构建使用内容摘要
  `8f09f164b8e88feec85703139d718a7dfa3a2402f1752818590ebe12e1c75b33`。
- 精确 fresh PG/Browser Compose 项目由验收 harness 清理；最终资源与进程残留已在总门禁后重新核对。
- 独立只读安全终审在最终树确认 P0/P1/P2 均为 0。匹配本轮 commissioning 的容器、network、volume、
  5173/8543/8787 listener 与 Playwright/Chromium 进程均为 0；3 个无关历史 managed volume 和 73 个
  未获清理授权的广义旧测试临时目录继续保留，未读取内容，也不冒充本轮残留。
- 当前证据不包含 commit、PR、required CI、hk-vps 发布、真实 provider 请求、真实费用或 webhook；
  这些边界仍为未授权/`blocked_external_provider`。
