# macOS Web 产品面对齐验收记录

> 日期：2026-08-10
> 整体状态：**本地软件与工作区总门禁通过；待 PR 与 main required CI**
> 执行计划：[ADR-36 后续 1–6 交付计划](../plans/2026-08-10-post-adr36-delivery-plan.md)
> 证据等级：`software_only`

## 1. 验收目标

证明当前 Web 柜台的用户可见产品面在 Browser 与 macOS 打包 Counter 中保持一致，并从全新本地数据库走通投产与凭据切换；随后用独立 Runtime.app 托管真实 Server OCI，证明打包 Counter 只通过固定 loopback bridge 工作。

本记录不把软件证据扩大为 XP-58 实体打印、Developer ID/公证、正式双架构 OCI、Windows 真实主机或生产云证据。PR 合入与 `main` required CI 完成前，阶段 1 仍为执行中。

## 2. 新鲜结果

| 验收项               | 命令                                 | 结果        | 当前证据                                                                         |
| -------------------- | ------------------------------------ | ----------- | -------------------------------------------------------------------------------- |
| Browser 当前产品面   | `pnpm local:acceptance`              | **通过**    | 17/17；与同轮真实 PostgreSQL/Server 交互                                         |
| macOS 打包 Counter   | `pnpm local:acceptance`              | **通过**    | 7/7；固定 desktop bridge；最终输出 `LOCAL_ACCEPTANCE_OK`                         |
| 全新 macOS 投产      | `pnpm local:commissioning:fresh:mac` | **通过**    | 1/1；最终输出 `LOCAL_FRESH_COMMISSIONING_ACCEPTANCE_OK`                          |
| Runtime 托管回环组合 | `pnpm runtime:counter:acceptance`    | **通过**    | System runner；install/stop/start/restart；staged/window health；`cleanup=clean` |
| 工作区总门禁         | `pnpm workspace:check`               | **通过**    | format/lint/typecheck/test/build 全绿；Node 本地与 Runtime 276/276               |
| 合入后 required CI   | GitHub Actions                       | **pending** | 待 PR 合入后记录                                                                 |

以上计数只对应 2026-08-10 的新鲜本地运行；不从更早验收记录推导当前通过状态。运行使用进程环境中的临时唯一凭据，文档不记录密码、PIN、token、cookie、私钥或顾客 PII。

## 3. Browser 与打包 Counter 覆盖

打包 Counter 的 7 条串行旅程与 Browser 当前产品面共同覆盖：

1. Server 不可用时的明确失败、恢复后登录，以及桌面 bridge 不向 renderer 暴露 bearer/cookie。
2. 价目、顾客、开单、挂单、撤销、补缴、退款、件级履约、上架、条码定位与取衣。
3. 衣物照片上传/查看/删除，输入为完整可解码 JPEG；服务端继续执行文件头、重编码与摘要门禁。
4. 会员档位、充值、余额消费、本金退款、冻结/解冻/关户，以及顾客合并、隐私导出和匿名化。
5. 催取名单、日/月/职员账目、对账、交班与 CSV 下载；下载固定落在隔离验收目录，并校验文件名、普通文件和大小上限。
6. 当前设置面：价目、会员、员工、离线、CUPS、legacy 与 R5 step-up；桌面命令投影包含既有 `platform.settings.set`。
7. 离线队列恢复与重放，以及 auth、command、query、health、photo、offline、printer 七个固定 namespace；不存在通用 IPC 或任意 URL/文件/命令桥接。

Browser 17/17 用同一真实本地 Server/PostgreSQL 覆盖当前 Web 行为。两层一起证明产品面一致，但不会把软件 fake CUPS/ESC-POS 状态解释为真实打印机已经出纸。

## 4. 全新投产与凭据切换

全新 macOS 验收从隔离空卷开始，不用 E2E SQL 绕过应用边界。当前 1/1 结果证明：

- 双管理员投产完成后可进入 Counter shell；
- 员工密码重置后，旧密码明确返回认证失败且不能进入 shell，新密码可以登录；
- 员工 PIN 重置前的 PIN 曾成功使用，重置后旧 PIN 失败、新 PIN 成功；
- 运行结束后由验收生命周期清理本轮本地栈。

## 5. Runtime 托管回环结果

`pnpm runtime:counter:acceptance` 已新鲜证明：

1. Runtime 测试 App 安装并托管真实 Server OCI，health ready 后打包 Counter 可通过固定 loopback bridge 工作。
2. Runtime stop/down 后 Server 与 Counter probe 明确不可用；start 后恢复。
3. restart 后重新通过 health 与 Counter probe，不依赖仓库 dev server。
4. 固定端口、App 路径和临时测试 key 由单实例主机 lease 保护；并发运行失败关闭。
5. SIGINT/SIGTERM/SIGHUP、子进程异常和超时路径均回收进程组、容器、卷、临时目录、测试 key 与 lease；信号终止不能误报成功。
6. 输出明确标记 `assurance=software_only` 和实际 runner，不声称正式签名或外部发布。

最终输出为 `RUNTIME_COUNTER_LOOPBACK_ACCEPTANCE_OK assurance=software_only runner=system ports=8543,8787 lifecycle=install,stop,start,restart staged_health=ready window_health=ready cleanup=clean`。退出后反向核查确认 8543/8787、验收进程、全局 lease、临时根以及带本轮标签的容器、镜像和卷均不存在。阶段 1 的本地软件与工作区证据已关闭，但整体阶段仍等待 PR 合入与 `main` required CI。

## 6. 外部门禁

| 门禁                         | 本记录结论                                                          |
| ---------------------------- | ------------------------------------------------------------------- |
| XP-58 实体打印               | 未验证；必须在阶段 2 检查中文、金额、条码、走纸、切刀和断连恢复     |
| Developer ID/公证/Gatekeeper | 未验证；ad-hoc/临时 key 只用于软件验收                              |
| 正式双架构 OCI               | 未验证；测试 Server OCI 不等于已发布和签名的 arm64/x86_64 OCI index |
| Windows 真实主机             | 未验证；不以 CI runner 代替                                         |
| 生产 SaaS                    | 未验证；hk-vps 合成数据环境不等于生产多租户/SLA                     |
| AI/BYOK/v1 迁移/外部提供商   | 未验证；属于固定顺序的阶段 6                                        |
