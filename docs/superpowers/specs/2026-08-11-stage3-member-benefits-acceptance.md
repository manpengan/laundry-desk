# 阶段 3.3 会员权益与有效期验收记录

> 日期：2026-08-11
> 状态：**本地实现与门禁完成；尚未形成 PR、主线 CI 或 hk-vps 发布证据**
> 决策：[ADR-41](../../adr/2026-08-11-adr-41-member-benefits-and-expiry.md)
> 基线：Stage 3.2 本地候选工作树；`main=origin/main=1c25dfd4423bb9033673e47bc058158086929407`

## 1. 范围

本记录只覆盖虚拟会员等级、服务端订单积分、次卡、固定金额券和各自有效期。储值资金有效期、
实体卡、支付机构、复杂营销、等级折扣、顾客扩展档案及阶段 4 均不在本片。

## 2. 证据矩阵

| 层级       | 目标                                                                         | 当前状态             |
| ---------- | ---------------------------------------------------------------------------- | -------------------- |
| Contracts  | 6 commands / 2 queries、严格联合、50/32 freeze、AI/offline 不扩面            | 完成                 |
| PostgreSQL | 0050/12 表、组织 RLS、append-only 账本/券冲正、定义并发锁、订单事务与 replay | 完成；真库 3/3       |
| Server     | 定义 CAS、状态/到期/闭店、积分 FIFO、次卡、券核销/取消冲正与同事务审计       | 完成；定向 23/23     |
| Web        | 设置定义、顾客资产、订单入口、严格解析、稳定幂等键、错误/空态/到期态         | 完成；命令客户端 7/7 |
| Browser    | 全新投产后完成定义、等级、次卡、券、订单与积分旅程及请求体边界               | 完成；精确 1/1       |
| Cloud      | ADR-41 合成 API journey 与既有发布/浏览器边界回归                            | 完成；198/198        |
| Workspace  | audit/format/lint/typecheck/test/build、SPA drift                            | 完成；总门禁 exit 0  |
| Security   | 券冲正、并发/闭店、审计、HTTP 幂等与 secret/residual 终审                    | 完成；P0/P1/P2 = 0   |
| GitHub     | PR、required checks、精确 merge SHA 主线 CI                                  | 未授权/未执行        |
| hk-vps     | 两阶段发布、marker/0050/API/Cloud Chromium/审计与清理                        | 未授权/未执行        |

## 3. 本地候选证据（2026-08-12）

- 全新隔离 PostgreSQL 完成 50 个迁移首次执行与 replay；ADR-41 真库 3/3 覆盖积分/次卡并发、
  券核销→取消冲正→另一订单再使用、审计失败整笔回滚、闭店拒绝与定义退休锁等待。
- fresh-browser 先通过空卷投产/双管理员 1/1，再精确运行会员 Chromium 旅程 1/1；另一次完整
  本地 Browser 18/18 也包含同一旅程。两轮容器、network、volume、私有配置根、浏览器与端口
  均在结束后归零。
- Cloud 工具 198/198；Web command client 7/7 证明网络异常和结构化 500 后相同请求沿用原 UUID，
  成功后下一次业务动作才生成新键。
- 早期隔离验收曾把临时配置中的随机测试 secret 回显到会话；相关 A/B/C/D 栈、卷、目录和浏览器
  会话已销毁并以全新四组随机值轮换；最终精确和广域残留复核均为 0。
- 首轮 workspace 在 SPA drift 门禁捕获手工 Web build 消费陈旧 workspace 依赖的问题；`spa:verify`
  已改为先通过 Turbo 构建 Web 依赖图，再检查 manifest。修复后独立 Edge 403/403、SPA check 与
  第二轮 `workspace:check` 均通过；后者包含 audit high/critical 0、lint 9/9、typecheck 12/12、
  Foundation 278/278、Contracts 772、DB 72、Server 812 pass/74 opt-in skip/0 fail、Cloud 198/198
  和 build 9/9。

## 4. 不可替代的关闭条件

- 资金储值测试不能替代积分、次数和券的独立账本/到期证据。
- 静态 SQL 不能替代真实 PostgreSQL 的并发锁、RLS、唯一约束和订单回滚。
- Web 单元测试不能替代真实 Browser 请求体边界与操作旅程。
- 本地实现完成后可以按用户授权进入 3.4；PR/CI/hk-vps/公网证据仍独立 pending，不得标成已发布。
