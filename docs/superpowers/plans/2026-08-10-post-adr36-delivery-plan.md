# ADR-36 后续 1–6 交付计划

> 日期：2026-08-10
> 状态：**执行中（阶段 1）**
> 当前阶段验收：[macOS Web 产品面对齐验收](../specs/2026-08-10-macos-web-product-parity-acceptance.md)
> 既有裁决：[ADR-14](../../adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md) · [ADR-16](../../adr/2026-07-31-adr-16-edge-operations-scope-ratification.md) · [ADR-36](../../adr/2026-08-09-adr-36-cloud-test-environment.md)

## 1. 目标与推进规则

在不改写既有 Accepted ADR 的前提下，把 ADR-36 之后的开发按 1–6 固定顺序收口。每个阶段都要形成独立、可复现且与声明层级相符的证据。

推进规则：

1. 当前阶段实现完成后，先跑与行为和风险相称的新鲜测试。
2. 测试通过后提交到阶段分支，通过 PR 合入 `main`，并确认 `main` required CI 绿灯。
3. 只有上一步全部完成，才开始下一阶段；不得并行把后续能力混进当前阶段。
4. 硬件、证书、外部账号、真实主机或提供商缺失时，阶段状态明确记为 **阻塞**，不得用 mock、ad-hoc 签名、CI 或其他平台证据替代。
5. 任何新增命令/查询或对外能力边界变化，继续遵守 ADR-16 的同批 ADR、CHANGELOG 与验收记录门禁。

## 2. 固定交付顺序

| 阶段 | 状态       | 范围                                                   | 必须关闭的证据                                                                                                                      |
| ---: | ---------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
|    1 | **执行中** | macOS 当前 Web 产品面 + Runtime.app 托管 loopback 组合 | Browser 与打包 Counter 同产品面；全新投产与凭据切换；Runtime 托管真实 Server OCI 后的 stop/start/restart 与 Counter 桥接；`main` CI |
|    2 | pending    | XP-58 真机                                             | 实际中文、金额、条码、走纸、切刀、断连/恢复和重复打印边界；记录打印机型号、连接方式与现场结果                                       |
|    3 | pending    | Developer ID、公证与正式双架构 OCI                     | Developer ID 签名、notary/staple/Gatekeeper；arm64/x86_64 正式 OCI index、签名 manifest、干净机安装/升级/回滚                       |
|    4 | pending    | Windows 打包与真实主机                                 | 真实 Windows 主机安装、启动、升级/卸载、持久化、打印与安全基线；不能只依赖 `windows-latest` CI                                      |
|    5 | pending    | 生产 SaaS、多门店与运维                                | 正式环境租户隔离、容量/SLA、备份恢复、监控告警、发布回滚、事故与数据运维；hk-vps 合成测试环境不作为生产证据                         |
|    6 | pending    | AI/BYOK、v1 迁移与外部提供商                           | 模型密钥隔离与成本/失败降级、真实 v1 只读迁移演练、短信/微信/支付等提供商 sandbox 与正式切换边界                                    |

## 3. 阶段 1 关闭条件

阶段 1 只在以下各项同时满足后关闭：

- `pnpm local:acceptance` 在同一轮真实本地栈中完成 Browser 与打包 Counter 产品面对齐，并输出成功 marker。
- `pnpm local:commissioning:fresh:mac` 从全新卷开始，通过双管理员投产、员工密码与 PIN 重置前后的新旧凭据切换。
- `pnpm runtime:counter:acceptance` 使用 Runtime.app 托管真实 Server OCI，完成 install/health/Counter probe、stop/down、start、restart、正常桥接与失败路径清理。
- 验收使用临时且不入库的凭据；退出后无遗留容器、卷、临时密钥、锁或合成下载物。
- 相关测试、lint、typecheck、build 与 `workspace:check` 新鲜通过。
- 变更经 PR 合入 `main`，并确认 `main` required CI 绿灯。

阶段 1 的所有本地包、临时 key 和 Runtime 测试组合均标记 `software_only`。它不关闭阶段 2 的 XP-58 实体门禁，也不关闭阶段 3 的 Developer ID、公证和正式 OCI 门禁。

## 4. 当前证据与剩余工作

截至 2026-08-10：

- `pnpm local:acceptance`：Browser 17/17、打包 Counter 7/7，`LOCAL_ACCEPTANCE_OK`。
- `pnpm local:commissioning:fresh:mac`：1/1，`LOCAL_FRESH_COMMISSIONING_ACCEPTANCE_OK`。
- `pnpm runtime:counter:acceptance`：**通过**；真实 System runner 完成 install/stop/start/restart、staged/window health 与严格清理，输出 `assurance=software_only` marker。
- `pnpm workspace:check`：**通过**；format、lint、typecheck、test、build 全绿，Node 本地与 Runtime 276/276。
- 提交、PR、`main` required CI：**待执行**。

因此阶段 1 的本地软件验收与工作区总门禁已通过，但在 PR 与 `main` required CI 关闭前仍为“执行中”；阶段 2–6 不启动。

## 5. 证据边界

- Browser/Counter 通过只证明当前 macOS 软件产品面，不证明打印机真实出纸。
- Runtime 托管回环通过只证明本机测试 Runtime 与真实 Server OCI/Counter 的软件组合，不证明正式分发物。
- ad-hoc 或临时测试签名不能作为 Developer ID、公证、staple 或 Gatekeeper 放行证据。
- 双架构源码可构建不等于正式 OCI index 已发布、签名、拉取并在干净机验收。
- GitHub Actions 的 Windows runner 不等于用户环境中的 Windows 安装、打印和升级验收。
- hk-vps 只承载合成数据云测试；它不证明生产级多租户、容量、SLA、备份恢复和事故运维。
- 模拟模型、假短信/支付提供商和合成迁移数据都不能冒充阶段 6 的真实外部集成或 v1 迁移完成。

## 6. 历史计划关系

[ADR-36 Web 产品收口计划](2026-08-09-adr36-web-product-convergence-plan.md)及其验收记录继续保留当时的 Linux Server/Web 云测试事实和 pending 项，不回写为已经完成。本计划仅定义 ADR-36 后的当前推进顺序与关闭门禁。
