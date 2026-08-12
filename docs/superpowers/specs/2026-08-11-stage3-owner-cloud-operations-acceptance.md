# 阶段 3.2 Owner 公网经营与授权门店管理验收记录

> 日期：2026-08-11
> 状态：**本地实现与门禁已完成；尚未形成 PR、主线 CI 或 hk-vps 发布证据**
> 决策：[ADR-40](../../adr/2026-08-11-adr-40-cloud-owner-operations.md)
> 基线：`main=origin/main=1c25dfd4423bb9033673e47bc058158086929407`

## 1. 范围

本记录只覆盖 ADR-37 阶段 3.2：Owner Cloud Web 三页 IA、复用 ADR-24 完整双口径报表、
授权门店目录、重新认证切店、当前门店名称 CAS 更新和既有员工 R5 治理。会员等级/积分/次卡/
券、顾客扩展档案、阶段 4 大模块、桌面/硬件和真实迁移门禁均不在本片。

## 2. 证据矩阵

| 层级        | 目标                                                                                          | 当前状态                         |
| ----------- | --------------------------------------------------------------------------------------------- | -------------------------------- |
| Contracts   | `store.authorized.list`、`store.profile.set` 严格 schema；44 commands / 30 queries；AI 不扩面 | 已实现；定向测试通过             |
| Server/Auth | 动态会话投影、逐店 admin 复核、CAS/R5/审计；非首店旧柜台面失败关闭                            | 已实现；聚焦安全复核通过         |
| PostgreSQL  | 0049 版本触发器、RLS/跨店隔离、陈旧并发、回滚、动态会话显示                                   | 独立空卷与 Owner 2/2 通过        |
| Web         | 今日/报表/门店 IA、重新认证切店、资料与员工管理、错误/空态/注销                               | 已实现；定向测试通过             |
| Browser     | 正常 Owner 只读旅程与普通 staff 拒绝；不残留前一门店状态                                      | harness/边界测试通过；公网待发布 |
| Workspace   | format/lint/typecheck/test/build 与 SPA drift                                                 | 总门禁通过                       |
| GitHub      | PR、required checks、精确 merge SHA 主线 CI                                                   | 未授权/未执行                    |
| hk-vps      | 两阶段发布、marker/schema/API/Cloud Chromium/安全与清理                                       | SSH 指纹核验受阻且未授权发布     |

## 3. 不可替代的关闭条件

- 内存/静态 SQL 不能替代真实 PostgreSQL RLS、事务和并发证据。
- 本地 Browser 不能替代公网 Origin/Host/Cookie/Caddy 行为。
- 公网只读截图不能替代命令总线、R5 审批、审计与清理回读。
- required CI 绿灯不能替代精确 merge SHA 的 hk-vps marker 与 Cloud 验收。
- 在上述层级全部完成前，本记录不得把 Stage 3.2 标为正式发布关闭。Contracts、Server、隔离真实
  PostgreSQL、Browser harness、workspace 总门禁和聚焦安全复核全部通过后，可按用户授权继续
  Stage 3.3 的本地软件实现；PR/CI/hk-vps/公网证据仍作为 Stage 3.2 独立待办，不得冒充完成。

## 4. 当前 blocker

- 本轮只获实现与测试授权，尚未获 commit、push、PR、merge 或发布授权。
- hk-vps 22 端口可达，但严格 ED25519 `ssh-keyscan` 连续失败；恢复独立指纹核验前不得 SSH。

## 5. 本地关闭证据

- `pnpm workspace:check`：依赖审计 high/critical 为 0，format、9 package lint、12 task
  typecheck、全部 workspace tests、Cloud 197/197 与 9/9 build 全绿；SPA 同步 3 项无漂移。
- 隔离 PostgreSQL 16：空卷应用 49 条 migration，Owner 纵向 2/2；覆盖角色降级后的旧
  Bearer/refresh、密码重登、PIN quick switch 失败关闭，以及第二管理员完成 R5 门店改名。
- 聚焦安全复核：P0/P1/P2 均无残留；员工目录响应带 `Cache-Control: no-store`。
- `git diff --check` 与活动文件规模门禁通过；隔离容器、volume、私有配置和临时 runner 均已清理。
