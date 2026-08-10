# XP-58 实体打印验收记录

> 日期：2026-08-10
> 历史状态：**原 1–6 计划的阶段 2 为 blocked_external_hardware**
> 主线基线：`main=7e72b57`
> 当前路线：本记录保留现场盘点与恢复入口；阶段编号和阻塞关系已由
> [ADR-37](../../adr/2026-08-10-adr-37-cloud-web-primary-delivery.md) 取代，XP-58 不阻塞当前
> [Cloud Web 1–4 计划](../plans/2026-08-10-post-adr36-delivery-plan.md)
> 既有裁决：[ADR-34：设备本地 CUPS 打印配置](../../adr/2026-08-08-adr-34-device-local-cups-printer-configuration.md)

## 1. 本阶段要证明什么

恢复 XP-58 独立门禁时，必须让待交付的打包 macOS Counter 经真实订单快照、设备签名 claim、ESC/POS 渲染和本机 CUPS 队列驱动同一台 XP-58，现场证明：

1. 中文与全角金额清晰正确；
2. CODE128 能由实际扫码设备回读；
3. 走纸和撕纸或切刀行为符合机型；
4. 实体断连不会产生迟到或重复票据；
5. 操作员显式补打后恰好再出一份；
6. 三次操作都能由私有 ledger 中已上传的设备签名回执和同一订单快照复核。

单元测试、模拟打印、CUPS 接单、CI、软件回环或操作员只点选“通过”都不能替代上述实物证据。

## 2. 2026-08-10 新鲜现场盘点

目标主机为 arm64 macOS 26.5.2。盘点只读取本机设备与服务状态，没有创建队列、改变 CUPS 配置或提交打印任务。

| 检查面     | 新鲜结果                                                                                            | 判定                  |
| ---------- | --------------------------------------------------------------------------------------------------- | --------------------- |
| 环境重定向 | `CUPS_SERVER`、`IPP_PORT`、`PRINTER`、`LPDEST` 均未设置                                             | 未把检查导向远端 CUPS |
| CUPS 队列  | `lpstat -h localhost:631 -e` 无输出；scheduler 运行，但无默认目的地、队列或设备 URI                 | 无可验收队列          |
| 系统打印机 | `system_profiler SPPrintersDataType -detailLevel full` 返回 printers list empty                     | 无已安装打印机        |
| USB        | IORegistry 未发现 Xprinter、XP-58、58mm、thermal 或 printer；USB Printer interface class 7 数量为 0 | 无 USB 打印设备       |
| 串口       | `/dev/cu.*`、`/dev/tty.*` 与 `IOSerialBSDClient` 仅有蓝牙和 debug console                           | 无 USB 串口桥         |
| 局域网     | `_ipp._tcp`、`_ipps._tcp`、`_printer._tcp` 均无发现                                                 | 无可用网络打印服务    |

因此未运行 `printer-acceptance:mac`，也没有生成实体通过记录。当前 blocker 是：目标 XP-58 未接入并通电，本机没有指向它的可用 CUPS 队列。

## 3. 软件侧关闭的证据缺口

现场硬件缺失不妨碍先修复会让真机旅程必然失败或假绿的软件问题：

- 柜台小票入队只提交严格契约允许的 `order_id`，不再携带多余 `ticket_no`。
- 桌面入队存在时，成功或失败都不会再调用浏览器 `window.print()`；动作门闩阻止重复点击形成多个任务，错误会在界面可见。
- PostgreSQL 为原始入队派生 `root:<order_uuid>:<kind>`，为补打或重试派生 `child:<source_uuid>`；相同逻辑请求在刷新、跨客户端或 COMMIT 后响应丢失时回读同一权威任务。迁移前已经存在歧义重复的历史组保持 `NULL` 并失败关闭，不会被猜测性合并。
- 纯 Browser 没有桌面入队 handler 时仍保留浏览器打印。
- 打印队列向操作员显示 `job_id`，但不暴露订单内部 ID 或顾客资料。
- macOS 实体验收 schema v3 必须绑定三个不同 UUID，并由已上传设备签名回执证明精确 `enqueue/null → reprint/<original> → retry/<disconnect>` lineage：原始成功、断连失败或不确定、恢复后的显式补打成功。三者必须共享 queue 和 snapshot，receipt sequence 严格递增，两个成功 CUPS job id 不同。
- 记录还绑定操作员输入的 XP-58 型号、受限连接类型，以及稳定读取的 packaged `app.asar`、SPA manifest 和 `Info.plist` 身份、版本与 SHA-256；原始 job、queue 和 CUPS job id 不写入公开记录。

这些改动只让现场验收可执行、可追溯且失败关闭，不代表已经出纸。

## 4. 软件检查点的新鲜门禁

2026-08-10 在没有打印机、且不发起实体打印的边界内完成：

- Web 350/350；
- Edge Agent scripts 56/56、dist 403/403，其中 schema v3、严格 CLI、签名 lineage、目录/工件竞态防护与 App 身份读取定向回归 21/21；
- 数据库静态回归 68/68；独立真实 PostgreSQL 16 从 0046 迁移到 root/child replay、REPEATABLE READ 竞争与 READ COMMITTED `ON CONFLICT` 回读共 8/8，零 skip；
- Contracts、Server、Web、Edge Agent 与 DB 的相关 typecheck、ESLint、Prettier、构建、SPA 同步和完整性检查全部通过；
- `pnpm run workspace:check` 完整通过 audit、format、lint、typecheck、test、Cloud 32/32 与 build；基础/Runtime 276/276，Server 常规套件 763 pass，69 个真实 PostgreSQL opt-in 用例在默认门禁中按设计跳过并由独立 8/8 零跳过回归补证。

提交的 Counter SPA manifest 指向本次源代码构建的内容寻址 bundle。以上结果仍是软件检查点，不改变本记录的 `blocked_external_hardware` 状态。

## 5. 恢复条件与现场步骤

恢复 XP-58 独立验收前必须先满足：

1. 将已通电 XP-58 通过 USB、以太网或 Wi-Fi 接入这台 Mac；
2. 安装并启用真实 CUPS 队列，确认 `lpstat -e/-p/-v` 可见且队列 accepting/idle；
3. 用 `printer-pilot:mac -- --discover` 和 `--cups-queue <queue> --validate` 只读核对安全队列；
4. 使用待交付 packaged `.app` 和同一真实订单，依次完成原始打印、实体断连重试、恢复连接后显式补打一份；
5. 保存三条已上传设备签名回执的 `job_id`，再运行仓库文档中的 schema v3 `printer-acceptance:mac` 命令；
6. 现场核对中文、金额、扫码、走纸、撕纸或切刀、断连不重复和补打恰好一份，并另存去 EXIF 的样张照片。

精确命令、参数和勾选口径见 [macOS 打印机 smoke](../../../apps/edge-agent/docs/printer-smoke-macos.md) 与 [打印机实验室清单](../../../tools/lab/printers/CHECKLIST.md)。

## 6. 顺序边界

本记录只有在上述实体证据通过、相关软件门禁绿灯、变更合入 `main` 且主线 CI 再次通过后才可标记 completed。它不再阻塞 ADR-37 的 Cloud Web 1–4；Developer ID、公证、Windows 与 XP-58 均在恢复时形成独立阶段。Cloud Web、生产数据保护或外部提供商能力仍必须以各自证据关闭，不能借本记录相互回填。
