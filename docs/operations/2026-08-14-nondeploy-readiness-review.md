# 通用 V2 非部署就绪度复核

日期：2026-08-14

证据等级：`software_only`

## 判定口径

本记录只评估 ADR-37 当前活动线：通用 V2 Cloud Web 及仓库内可完成的软件门禁。是否交付仍以
`main` 代码和 required checks 为准；下列七个软件批次均已按顺序通过 PR required checks 并合入
`main`。本轮按用户要求不执行部署，也不把 Windows、macOS 正式发行、XP-58 实体验收、真实
provider 或离机介质证据计入 Cloud Web 功能开发阻塞项。

## 本轮可完成工作

| 批次 | 软件闭环                                                                   | 主干证据         |
| ---- | -------------------------------------------------------------------------- | ---------------- |
| 1    | 消除 `nanoid` high advisory，依赖门禁回到 high 0 / critical 0              | #183 / `e7e8886` |
| 2    | 路由级拆包并锁定生产 bundle 预算                                           | #184 / `41e1e4a` |
| 3    | 用完整迁移 ledger、关键表证据和精确清理补强 PostgreSQL 影子恢复演练        | #185 / `2c76ef8` |
| 4    | 固化脱敏 V1 SQLite 真实读取的确定性迁移演练，拒绝 link、sidecar 与坏完整性 | #186 / `ef3434c` |
| 5    | 固化 software-only release candidate 组装与 SPA 保留 dry-run               | #188 / `b267e03` |
| 6    | 在 macOS CI 构建、检查并隔离 smoke 未签名 `.app`，不上传或发布制品         | #189 / `16f801b` |
| 7    | 补齐通知 adapter 声明并收紧 AI provider smoke 的模型、流与工具失败关闭     | #190 / `7e68994` |

第 2 批锁定的 Web 指标为最大 chunk 231859 bytes、initial JS 572858 bytes、总 JS 1139667
bytes、总 CSS 99327 bytes。本轮全量 `workspace:check` 再次得到相同预算结果。

## 当前完成度

| 范围                              | 结论                                                                    |
| --------------------------------- | ----------------------------------------------------------------------- |
| 通用 V2 Cloud Web 既定产品面      | 阶段 4.5 代码基线已闭环；冻结面为 82 commands / 64 queries、迁移头 0069 |
| 本轮获授权的非部署软件工作        | 七个软件批次已按顺序通过全部 required checks 并合入 `main`              |
| 正式 Cloud 部署与公网新鲜证据     | 本轮未执行；不能用主干软件绿灯替代                                      |
| 真实 provider、离机备份和生产容量 | 外部证据未齐，继续失败关闭                                              |
| 桌面正式发行与实体硬件            | ADR-37 明确后置，不阻塞当前 Cloud Web 活动线                            |

因此，按“当前授权且不含部署”的口径，软件实现完成度为 **100% 闭环并已主干集成**；按正式生产交付
口径不能称为 100%，因为部署、新鲜公网验收和下列外部证据均未在本轮取得。

## 复核证据

- 全量 `workspace:check` 通过：依赖审计 high 0 / critical 0，9 个 workspace 的 lint、strict
  typecheck、build 全绿；Server 1167 项为 1065 pass / 102 个真实 PostgreSQL 用例按本地门禁设计
  跳过，Cloud acceptance 304/304 通过。PR #183–#186、#188–#190 的 `workspace-check`、
  `real-postgres` 和 `runtime-app-macos` required checks 均成功。
- 生产 Web 预算通过；本轮七个软件批次没有增加命令、查询、迁移或 `m2-freeze` 清单。
- 本轮新增/触及的生产文件均低于 400 physical lines，测试文件低于 800；既有冻结预算没有增长。
- 本记录初版误沿用了 ADR-51 切片结束时的 69/48 历史数值；当前冻结测试真源在后续
  ADR-52–63 合入后已为 82/64。本订正只修复当时的“当前主干”汇总，不改写各历史切片自己的验收数值。
- 活动 Cloud Web 源码未发现 `TODO`、`FIXME` 或 `NOT_IMPLEMENTED`。扫描命中的 OS KeyStore 占位只
  位于 ADR-37 已后置的桌面发行线。
- 依赖审计仍有两项精确复审的 moderate 例外：Drizzle CLI 的 dev-only `esbuild@0.18.20`，以及
  历史 Excel/腾讯 SDK 路径的 `uuid@8.3.2/9.0.1`；路径、版本、severity 或可达性漂移会立即失败。

## 明确剩余项

- 随本记录合入，本轮获授权的仓库内非部署事项闭环；后续变更仍须通过 required checks，不能绕过
  保护。
- 用户重新授权前不部署 hk-vps，不生成新的公网完成声明，也不操作线上数据。
- 真实短信/微信仍需账号、获批模板、整数费用与额度、稳定幂等、签名 webhook、重复/乱序回执、失败
  和撤销证据；缺任一项保持 `blocked_external_provider`，人工名单继续可用。
- 正式 AI provider 仍需独立密钥权威、额度和真实失败证据；本轮只验证无网络协议核心。
- 离机备份 authority、恢复介质和告警链仍是 `blocked_external_offsite`；同机 shadow drill 不能替代。
- V1 只完成脱敏真实结构演练；正式顾客数据迁移需另行授权和数据保管方案。
- Developer ID、公证/staple、Windows 正式安装链、XP-58 实体出纸和生产容量继续按 ADR-37 后置。
