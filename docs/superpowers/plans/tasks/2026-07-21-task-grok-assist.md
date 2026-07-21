# laundry-v2 当前任务书 · Grok（受约束协助线）

> 下发：manpengan　日期：2026-07-21
> 决策依据：[ADR-10](../../../adr/2026-07-21-adr-10-single-owner-delivery-governance.md)
> 上游 owner：Codex。未收到冻结 contracts/ports 与验收断言，不自行设计协议。

## 1. 可承担范围

- `apps/web` 页面、交互、可访问性、视觉回归、Playwright；
- `packages/ui` 组件与主题；
- `apps/edge-agent/src/platform/`、`drivers/`、`packaging/` adapters；
- OS 凭据区、autoUpdater、文件/设备 I/O 的平台接线；
- XP-58、DL-206、GP-3120 驱动适配与实机证据；
- Windows 冷启动、WSS/LNA/防火墙、升级/恢复故障演练；
- 跨平台与端到端黑盒负向测试。

## 2. 禁止自行改变

- contracts 公共类型、canonicalization、签名范围；
- 密钥生成/派生/包装、nonce/seq、SQLCipher schema；
- actor/tenant、RLS、审计权限；
- lease、offline grant、回放仲裁；
- Policy、确认卡、step-up 与审批语义；
- 打印模板签名、job/receipt 和升级 manifest 不变量。

发现接口问题时提交复现、期望/实际与最小变更请求，由 Codex 修改设计或 contracts。

## 3. 当前候选任务

| 任务             | 开工前置                 | Grok 交付                              | Codex 交付/验收                     |
| ---------------- | ------------------------ | -------------------------------------- | ----------------------------------- |
| D1 平台闭环      | manifest/IPC schema 冻结 | 打包接线、Windows 冷启动证据           | 信任模型、签名/证书固定、IPC schema |
| D2 配对 adapters | A4 + Edge ports          | OS 凭据区和平台 I/O                    | 配对状态机、签名验证、负向测试      |
| D3 队列 adapters | A4 + queue ports         | SQLCipher/凭据区平台接线和故障注入     | DEK/KEK 生命周期、queue core        |
| D4 打印          | 模板/job/receipt schema  | 三族驱动、渲染、实机样张               | 签名模板与回执不变量                |
| D5 升级 I/O      | manifest/matrix ports    | autoUpdater、槽/快照 I/O、Windows 演练 | anti-rollback 与恢复语义            |
| E1 登录/PIN      | A5/A6/A7                 | 页面、交互、可访问性                   | C6/C8 + API/OpenAPI；黑盒验收       |
| E3 权限路由      | A6/A7                    | role × feature UI 门控                 | 服务端授权真源；越权负向验收        |

## 4. 完成定义

- 只消费冻结接口；无手写第二套 API 类型。
- 单测、视觉/可访问性测试和 Playwright 路径绿。
- 安全负向断言由 Codex 提供或复审。
- Windows/打印机任务必须有真实设备证据；没有设备只能标记“代码侧通过/待实测”。
- 独立 `grok/*` worktree/分支和 PR；不直接推 main；最终合并由 manpengan 执行。
