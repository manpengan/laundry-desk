# ADR-26：局域网只读 Owner Dashboard 与 HTTPS 边界

- 日期：2026-08-07
- 状态：**Accepted**
- 决策者：manpengan
- 前序：[ADR-16：边缘运营范围追认与契约面门禁](2026-07-31-adr-16-edge-operations-scope-ratification.md)、[ADR-24：账目双口径与有界日/月/职员报表](2026-08-07-adr-24-accounting-dual-basis-reports.md)
- 路线：[V2-M4 账务双口径、老板端与备份](../superpowers/plans/2026-07-19-v2-m2-m6-implementation-plan.md#3-v2-m4-账务双口径--老板端--备份还原)
- 影响：`packages/contracts` v0.2 查询冻结面、本地 Web HTTPS 暴露边界

## 背景

ADR-24 已交付可复算的双口径账目，但仍只适合柜台大屏。店主需要从同一门店局域网内的
手机查看今日经营摘要，而当前本地栈只绑定回环地址；直接把 Fastify 或 PostgreSQL 暴露
到局域网，会扩大认证、Host、Origin、Cookie 与数据库攻击面。

本片只交付一个只读、单门店 Owner Dashboard，并为第二台真实设备建立显式 HTTPS
入口。它不是云端老板端，也不恢复已后置的 macOS、Windows、AI 或自动通知工作。

## 决策

### 1. 只新增一个固定范围查询

新增 R1 查询 `reporting.owner_dashboard.get`：

- 输入为严格空对象；组织、门店、营业日、时区与切日时刻只取服务端会话和门店设置；
- 返回当前营业日、生成时刻、今日指标，以及最近连续 30 个营业日的趋势；缺失日补零；
- 7 日趋势由客户端取同一份权威结果的最后 7 行，不增加第二种参数或第二次查询；
- 单次查询在同一个 `REPEATABLE READ READ ONLY` 快照内完成；所有 PostgreSQL 读取同时
  依赖 RLS 与显式 `(org_id, store_id)` 条件；
- `offline_mode = denied`、`data_classification = internal`、最多 30 行，不进入当前 AI
  工具投影。

查询要求现有 `accounting_read` 权限。当前只有 `admin` 拥有该权限，因此 `admin` 是本片
唯一的店主代理角色；不新增 `owner` 或 `manager`，普通 `staff` 必须由服务端拒绝。

契约冻结面从 **22 → 23 条查询**，命令仍为 **39 条**。`m2-freeze.test.ts` 与 PR 描述
必须点名 `reporting.owner_dashboard.get`。

### 2. 指标口径固定且可复算

首屏四张指标卡固定为：

1. **今日营业额**：主值使用 ADR-24 的 `performance_income_cents`，并同时展示
   `real_income_cents`，禁止重新发明单一“支付合计”；
2. **今日取衣件数**：按 `garment_status_log` 在当前营业日发生的 `picked_up` 转换事件
   计件，不按订单创建日或衣物当前状态倒推；
3. **新增欠款**：今日新开、当前仍为 `open | closed` 且余额大于零的订单，在刷新时刻
   尚未收回的余额与订单数。它是当前余额快照，不宣称不可变的历史欠款发生额；
4. **滞留件**：订单已收满 30×24 小时、仍为 `open`，衣物当前为 `ready | racked` 的
   件数与去重订单数；不要求手机号，也不受催取名单的 50/200 行上限影响。

趋势只展示 ADR-24 的业绩与实收双口径，不把可变的“当前欠款”伪造成历史序列。

### 3. 局域网只开放同源 HTTPS 网关

PostgreSQL 与 Fastify 继续只映射到主机回环地址。新增本机 HTTPS 网关：

- 绑定操作者显式选择的单个非回环私网地址与端口，不默认监听 `0.0.0.0`；
- 证书与私钥由部署者从仓库外路径提供；私钥必须是普通文件、禁止符号链接，且权限不得
  宽于所有者读取；
- 同源提供已构建 SPA，并只把明确允许的本地 API 路径代理到回环 Fastify；不代理任意
  URL，也不接受或生成 `X-Forwarded-*`；
- 精确校验 Host、Origin 与 `Sec-Fetch-Site`，后端仍保持 `trustProxy = false`；响应设置
  CSP、禁止缓存、禁止嗅探和嵌入；
- LAN 模式要求显式 HTTPS Origin，并使用 host-only、`Secure`、`SameSite=Strict` Cookie；
  回环 HTTP 与 LAN HTTPS 是两种显式 profile，不靠 `NODE_ENV` 或自动网络探测切换。

网关不是反向代理信任边界：后端看到的连接来源仍是回环地址，登录/IP 限速会对局域网
客户端聚合，这是当前 fail-closed 取舍。若未来需要按终端区分，必须另行设计有签名的
可信代理协议，不能直接信任转发头。

### 4. 验收边界

交付必须同时证明：

- 契约拒绝任何客户端租户、门店、日期或额外字段；普通员工得到 403；查询响应不可缓存；
- 真实 PostgreSQL 覆盖营业日边界、跨门店污染负测、今日取衣事件、欠款快照、无手机号
  滞留件与连续 30 日补零；新索引迁移可重复校验且只做 expand；
- 本地 Web Server 经非回环 HTTPS 地址完成登录、四卡展示和 7/30 日切换；第二浏览器
  上下文可独立登录、显式退出，刷新后不得恢复已注销会话；错误 Host、跨站 Origin、
  转发头与非 HTTPS Origin 均被拒绝；
- PostgreSQL 与 Fastify 仍不能通过该局域网地址直接连接。

## 当前仍不做

- 跨店/跨组织汇总、云端访问、互联网穿透、域名与正式 PKI 托管；
- PWA 离线缓存、推送、短信/微信通知与自动周报；
- AI 经营分析、异常解释或对查询结果发起写操作；
- 新增 owner/manager 角色或远程审批；
- macOS App 恢复验收、Apple 签名公证、Windows 适配与云服务器部署。

## 后果

- ADR-24 §4 的“老板端 H5/PWA 不包含”是其历史交付边界；本 ADR 只覆盖同店局域网内的
  只读首屏，不改变 ADR-24 账目口径。
- 查询冻结面增加一项，命令面不增长；后续增加明细、跨店筛选或写操作必须另附 ADR。
- 本地运行文档必须明确证书、显式私网绑定、Secure Cookie 和第二设备验收步骤，不得把
  自签证书测试称为正式互联网发布。

## 否决的备选

- **直接把 Fastify 绑定到局域网**：会把多条内部/桌面路由一并暴露，且不能同源托管 SPA，
  否决。
- **把 PostgreSQL 映射到局域网**：浏览器不需要数据库连接，增加的攻击面没有产品收益，
  否决。
- **使用 HTTP 加 `Secure=false` Cookie**：第二设备会把会话暴露给同网段监听者，否决。
- **让浏览器上传 org/store/date 或自行汇总账目**：会破坏租户权威与营业日/账目口径，否决。
- **用当前订单余额生成 30 日欠款趋势**：可变快照无法证明历史发生额，否决。
