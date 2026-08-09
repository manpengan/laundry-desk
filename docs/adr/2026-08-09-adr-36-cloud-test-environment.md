# ADR-36：云测试环境与完整柜台面公网暴露

- 日期：2026-08-09
- 状态：**Accepted**
- 决策者：manpengan
- 修订：[ADR-14 §4 交付顺序](2026-07-25-adr-14-generic-local-first-v2-delivery.md)、[ADR-16 §3 阶段线重述](2026-07-31-adr-16-edge-operations-scope-ratification.md)
- 影响：交付阶段线、部署形态、Origin/Host 契约、桌面 App 优先级

## 背景

ADR-14 §4 把交付切成三段，第三段才是「云服务器部署与 Windows 适配」；ADR-16 §3
重申「云服务器部署、跨设备/多店同步、云侧租户运维」仍不在当前阶段。

2026-08-09，manpengan 裁决改变这一顺序：**后续优先部署到 hk-vps，直接在云服务器
上做测试，产品开发完成后再做桌面 App 适配**。

这不是「提前做生产上云」。裁决同时限定：该环境是**开发测试环境**，不承载真实门店
经营数据。

本 ADR 记录该裁决及其安全边界，避免重演 ADR-16 §背景 1 的情形——代码越过阶段线而
裁决没有更新，后来者无从判断哪些边界还算数。

## 决策

### 1. 新增「云测试环境」，它不是生产上云

活动交付线增加一个环境：`desk.manpengan.xyz`，运行在 hk-vps。它的用途是让
manpengan 随时打开浏览器验证在研功能，替代必须坐在开发机前跑本地 Compose。

**它不等于 ADR-14 §4 第三阶段的「云部署」**。以下仍然不在当前阶段，不因本 ADR 提前：

- 生产级云部署（多租户运维、SLA、容量规划）
- 跨设备 / 多店同步
- Windows 打包与实机适配
- AI / BYOK
- v1 数据迁移

### 2. 桌面 App 适配后置

macOS Electron 柜台与 Runtime.app 的开发与验收**移出当前关键路径**，待产品功能在
云测试环境上收敛后再统一适配。已交付的桌面成果（ADR-21、ADR-29 至 ADR-34）保持
有效，不回滚、不删除，但不再是每期的必过门禁。

本条修订 ADR-14 §4 第一段「本地 Web + macOS」中 macOS 与 Web 必须同期交付的隐含
要求。Linux 本地 Server + 浏览器仍是功能验收的真源。

### 3. 裸机部署，不引入容器运行时

hk-vps 已在生产服务 `kb.manpengan.xyz` 与代理转发。**该机不安装 Docker**：容器
运行时会插入 iptables 规则并改写 FORWARD 策略，对同机既有服务是不必要的风险。

云测试环境采用：

- PostgreSQL 16 由 apt 安装，仅监听 loopback；
- Fastify 由宿主机 Node 22 直接运行，监听 `127.0.0.1:8787`；
- 迁移走 `tools/compose/migrate-v2.sh` 的宿主 psql 路径（该脚本已支持，见其
  `with_psql`），不需要 compose 容器。

这一形态与产品设计 §3.3 已允许的「Compose 起 PG、宿主机运行 Fastify」同源，但把 PG
也落到宿主。**它明确不是容器化交付路径的验收**：`docker-compose.runtime.yml` 的
签名镜像、secrets 走文件、`read_only`、`cap_drop: ALL` 等生产加固**未被本环境覆盖**，
将来真正上生产时仍须独立验收。

### 4. 入口走 Caddy，不使用 LAN gateway

同机 Caddy 已占用 80/443 并自动签发 Let's Encrypt 证书。云测试环境复用它：

```
desk.manpengan.xyz  (Caddy: TLS 终止 + 自动证书)
    → reverse_proxy 127.0.0.1:8787，改写 Host 为 127.0.0.1:8787
        → Fastify（hostAuthorities 校验通过）
```

`hostAuthorities` 不需要改动：Caddy 转发时把 Host 改写为 `127.0.0.1:8787`，服务端既有
的 Host 白名单原样通过。

但**浏览器 origin 需要一处代码改动**。`LAUNDRY_LAN_ORIGIN` 的校验要求「私有 IPv4 +
端口 ≥1024」，`https://desk.manpengan.xyz`（公网域名、默认 443）双重不合格。该约束是
ADR-32 局域网形态的承重结构——LAN 用自签证书绑私有 IP，放宽它等于让局域网配置能接受
公网名字。因此**不放宽 `LAUNDRY_LAN_ORIGIN`，而是新增 `LAUNDRY_PUBLIC_ORIGIN`**：

- 校验为「精确 HTTPS origin + 公网域名 + 默认端口」，末段必须是字母，从而拒绝
  `https://127.0.0.1` 这类 IPv4 字面量，也拒绝 `localhost`、带端口、带路径、带凭据的形式；
- 与 `LAUNDRY_LAN_ORIGIN` **互斥**。两者同时设置直接失败：一台服务器只服务一个浏览器
  origin，同时接受会让 cookie 与 CSRF 策略绑定到哪一个取决于求值顺序；
- 任一设置都推出 `browserFetchSite=same-origin` 与 `cookieSecure=true`，与 LAN 形态一致。

`hostAuthorities`、CSRF、Fetch Metadata 与认证链均不因本条改动而放宽。

**本环境不经过 ADR-32 的 LAN gateway**，因此其 7 条 Owner 只读路由白名单
（`LAN_GATEWAY_PROXY_ROUTES`）不适用于此。LAN gateway 的裁决与实现不受本 ADR 影响，
局域网形态继续按 ADR-32 执行。

### 5. 完整柜台面暴露及其代偿约束

云测试环境开放**完整命令与查询面**，包括 `/v1/commands/*` 写操作——否则无法在云上
验证开单、收款、取衣与储值。这是本 ADR 最大的一处安全边界变更：ADR-32 之前，非
loopback 面从未接受过任何写命令。

代偿约束，全部为强制项：

1. **禁止真实顾客 PII**。该库只允许测试数据。真实门店经营数据继续只落本地 Runtime。
2. **独立密钥**。`LAUNDRY_ACCESS_TOKEN_SECRET`、`LAUNDRY_CSRF_PROOF_SECRET`、
   数据库口令与管理员凭据均为该环境独有，不与任何本地环境或未来生产环境共用。
3. **不启用 demo seed**。`LAUNDRY_LOCAL_DEMO` 不得设置；本环境走普通 bootstrap。
4. **PostgreSQL 不出 loopback**。仅 `127.0.0.1` 监听，不开防火墙端口，不做端口转发。
5. **暴露面即认证面**。除 `GET /health` 外所有路由要求会话；Host、Origin、
   Fetch Metadata 与 CSRF 校验保持现状不放宽，不得为「测试方便」加白名单或关校验。
6. **数据可随时丢弃**。该环境不承诺备份与恢复；ADR-29/33 的备份、换机与保留语义
   不覆盖此处。

### 6. 判据

「某能力在云测试环境可用」以 `desk.manpengan.xyz` 上的实际行为为准。该环境**不是
门禁**：CI 的 required checks 仍是 `workspace-check` 与 `real-postgres`，PR 放行与
本环境状态无关。云测试环境失效不阻塞交付。

## 后果

- ADR-14 §4 的三段阶段线中，第三段的「云服务器部署」被本 ADR 部分提前——仅限测试
  环境形态，且带 §5 的六条约束。Windows 适配不受影响，继续后置。
- ADR-16 §3 清单中的「云服务器部署」一项按本 ADR 修订；其余四项（跨设备同步、
  Windows、AI/BYOK、v1 迁移）保持不变。
- 桌面 App 退出每期必过门禁（§2），里程碑 1 验收记录中「同一 React UI 在浏览器和
  macOS App 运行」的同期要求随之放宽，历史记录不追改。
- hk-vps 上的既有服务（`kb.manpengan.xyz`、代理转发）与本环境共存，本环境不得
  改动其 Caddy 站点配置、不得占用 80/443 之外的公开端口。
- 本环境的完整柜台面是**公网可达的写入口**。它的安全性完全依赖 §5 的六条约束与
  服务端既有的认证链；任何一条被放宽都必须新出 ADR，不能作为部署便利默默调整。

## 否决的备选

- **在 hk-vps 装 Docker 跑 runtime compose**：更贴近未来生产形态，但会改写同机
  iptables 与 FORWARD 策略，危及正在生产服务的 kb 站点与代理转发。测试环境的收益
  不足以承担该风险，否决。
- **沿用 LAN gateway 的路由白名单**：只放行 7 条 Owner 只读路由，无法验证开单与
  收款——与「直接上云做测试」的裁决目的直接冲突，否决。
- **自建 TLS 终止（项目内 gateway 监听 443）**：与既有 Caddy 抢端口，且要自行处理
  证书签发与续期，而 Caddy 已经在做同一件事，否决。
- **把真实门店数据放上云测试环境**：省去造数据的功夫，但会让一个明确标注「可随时
  丢弃、不承诺备份」的环境承载个人信息，否决。
- **只写 ADR 不部署，等生产方案成熟**：manpengan 的裁决正是要用云环境替代本地
  Compose 做日常验证，继续等价于不执行裁决，否决。
