# 10 月代码提交审查（截至 c815bc7f）

审查对象：`b6e6d7f824a00cd009ef8f0de2f5df1691fdd9a0..c815bc7fab04fa3772379c14ff2ca694c0335e18`，即 10 月 1 日起进入 main 的 19 个主线合并提交。末次合并的 UTC 日期为 2026-10-09，用户时区为 2026-10-08。

审查时结论：确认 **7 项 P2 缺陷**。其中 5 项是 10 月 3 日报告所列问题，经本轮当前源码复验仍存在；2 项来自新增加的流畅度检测。审查阶段没有修改产品代码，没有提交、推送或部署。既有未跟踪的 `2026-10-03-recent-feature-review-issues.md` 原样保留。

**2026-10-09 修复进展：用户指定的第 1、6、7 项已在 `codex/fix-october-review-1-6-7` 本地修复。** 第 1 项仅将付款引用限定为收款行；隔离 PostgreSQL 16 已验证跨日退款不误报，以及应属于当天的缺失收款仍被发现。第 6 项统计完整采样时间及首尾无帧区间；第 7 项通过外观更新版本判断临时预览是否仍可恢复，保留检测期间的新选择。新增回归随代码保留；其余第 2–5 项未改动。以下缺陷描述保留为修复前的审查证据，不表示第 1、6、7 项仍未修复。新 Windows 安装包尚未实机复验；本报告记录修复与验证结果，合入状态以 Git 历史为准，未部署。

这是风险导向审查，不是全量逐行或生产放行：仅 apps/packages/tools（排除内置 SPA 产物）就有 905 个改动文件、79,337 行新增、6,820 行删除。重点追踪登录与维护入口、开单/取衣状态、支付与对账、小程序接口、离线会话与恢复、备份/升级、照片和主题。初始审查未运行 Windows 原生实机、真实 PostgreSQL 集成及外部支付/微信服务；测试替身的结论只覆盖相应逻辑边界。后续修复的真库验证见文末。

## 1. P2：跨日退款被误报为缺失原收款

- 位置：[reconciliation.ts:36](../../apps/server/src/payment-channels/reconciliation.ts#L36)，SQL 范围见第 25 行，最后的 `missing_provider` 扫描见第 87 行之后。
- 引入：`8fa5d827`；原 REVIEW-20261003-02，审查时仍未修复。
- 场景：10 月 2 日收 1000 分，10 月 3 日退款 300 分。导入 10 月 3 日的账单，只有退款行是正确输入。
- 根因：付款查询的 merchant_order 引用集合来自所有输入行，包含退款行。它把不属于当日的原收款拉进待核对集合，随后将原收款标为渠道缺失。
- 当前复验：调用真实 `reconcileChannelBill`，SQL 端口替身按源码的日期/引用条件选行，得到 `matched_count=1`，同时产生原收款的 `missing_provider`。这是逻辑复现，不是实际 PostgreSQL 执行。
- 影响：正常退款产生虚假差异，增加人工核销、复核工作；新增对账历史页面也会保存这个错误结果。
- 修复方向：付款引用只取 `kind=payment`，退款使用独立引用集合；增加前日付款、当日部分/全额退款的真库回归。

## 2. P2：Ctrl+Enter 在价目搜索框同时加品与提交

- 位置：[CatalogPicker.tsx:202](../../apps/web/src/pages/CatalogPicker.tsx#L202)，关联 [use-receive-keyboard.ts:37](../../apps/web/src/pages/use-receive-keyboard.ts#L37)。
- 引入：10 月柜台交互批次 `279b8eb8`；原 REVIEW-20261003-03，当前仍未修复。
- 场景：价目已加载，搜索框有焦点，按确认开单快捷键 Ctrl+Enter。
- 根因：搜索框将所有 Enter（包括 Ctrl/Meta 修饰键）当成“加入第一项”；`preventDefault` 不阻止事件传播到 document 级确认开单监听器。
- 当前复验：Chromium 挂载真实 CatalogPicker 与 useReceiveKeyboard；单次真实键盘事件得到 `{picked:1, submitted:1}`，页面无运行错误。
- 影响：只想提交已有订单的用户额外触发加品，录入内容变化与确认动作发生在同一个按键内。
- 修复方向：加品仅接受无 Ctrl/Meta/Alt 的 Enter；完整组件事件链需验证 Ctrl+Enter 只提交、不加品，普通 Enter 只加品。

## 3. P2：价目搜索保留失效分类，隐藏了所有结果与切换入口

- 位置：[CatalogPicker.tsx:78](../../apps/web/src/pages/CatalogPicker.tsx#L78)、第 216 行。
- 引入：10 月柜台交互批次；原 REVIEW-20261003-04，当前仍未修复。
- 场景：价目同时有干洗和水洗，选中干洗后搜索只匹配水洗的“衬衫”。
- 根因：响应替换 items，但 service 仍是 dry；过滤后 visible 为空。services 根据新 items 计算，只剩一类，于是全部分类按钮也被隐藏。
- 当前复验：Chromium 真实组件显示“1 项”，但可选项为 0、分类按钮为 0。
- 影响：存在的价目无法点选，用户必须清空搜索或知道 F1 快捷键才能恢复。
- 修复方向：响应中不存在当前分类时回到全部，或保留可见的“全部”入口与稳定分类集合。

## 4. P2：订单详情的键盘焦点在 summary 处循环

- 位置：[focus-trap.ts:4](../../packages/ui/src/lib/focus-trap.ts#L4)、第 100–107 行；实际页面入口为 [OrderDetailContent.tsx:98](../../apps/web/src/pages/OrderDetailContent.tsx#L98)。
- 来源：10 月订单抽屉新增 details/summary 暴露了既有焦点枚举遗漏；原 REVIEW-20261003-05，当前仍未修复。
- 根因：原生可聚焦的 summary 没有被 FOCUSABLE_SELECTOR 包含。浏览器自然 Tab 到 summary 后，下一次 Tab 被当成弹层外焦点，强制回到第一个控件。
- 当前复验：Chromium 使用真实 Drawer 与 details/summary，连续焦点为“更多信息 → 关闭 → 前置按钮 → 更多信息 → 关闭 → 前置按钮”；到不了后面的“上传照片”。
- 影响：键盘用户无法正常顺序操作 summary 之后的照片等控件。
- 修复方向：焦点枚举覆盖原生 summary，并核对折叠 details 内不可见控件过滤；增加真实浏览器的正反 Tab 回归。

## 5. P2：小程序订阅成功响应与客户端契约不一致

- 位置：[transaction-client.ts:85](../../apps/customer-miniapp/src/transaction-client.ts#L85)，服务端 [service.ts:166](../../apps/server/src/customer-miniapp/service.ts#L166)。
- 引入：`c6d3edb6`；原 REVIEW-20261003-01，当前仍未修复。
- 场景：顾客在原生订阅提示中允许模板，服务端记录成功后返回 `{recorded:true}`。
- 根因：客户端仍使用严格 `{accepted:true}` schema，必然拒绝实际返回值。
- 当前复验：真实 MiniappClient 与 createTransactions 接收服务端实际形状，抛出“服务返回异常，请稍后重试”；现有 controller 订阅测试替身仍返回 accepted，因而绿灯。
- 影响：订阅已经记录，界面却显示失败。公共小程序入口目前关闭，故该项是重新启用前必须解决的功能缺陷，不声称当前已有真实顾客受影响。
- 修复方向：采用共享结果契约，并测试服务端返回值与原生客户端之间的集成。

## 6. P2：流畅度检测忽略末尾停顿，可能把几乎不出帧判为流畅

- 位置：[motion-self-test.ts:65](../../apps/web/src/motion-self-test.ts#L65)，结束逻辑第 71–74 行；汇总算法第 29–42 行。
- 引入：`f943be1c`，本轮新发现。
- 场景：3 秒采样窗口只在 0ms 和 16ms 出帧，之后直到超时再无帧回调。
- 根因：只记录两次 rAF 之间的间隔，超时结束时丢弃最后一帧到截止时间之间的空白；fps 的分母也是已记录间隔总和，而非采样窗口。
- 当前复验：确定性时钟驱动真实 measureFrames/summarizeFrames，输出 `frames=1, fps=63, slowShare=0, verdict=smooth`。
- 影响：最需要降级的停顿场景可能提示“流畅，可以使用标准动效”，违背此功能的用途。
- 修复方向：保留实际采样开始/结束时间，把无帧区间纳入平均速率与停顿判断，覆盖尾部无帧、前部无帧和零帧场景。

## 7. P2：流畅度检测结束会覆盖检测中选择的“标准”动效

- 位置：[motion-self-test.ts:86](../../apps/web/src/motion-self-test.ts#L86)，恢复判断第 92–94 行。
- 引入：`f943be1c`，本轮新发现。
- 场景：当前为节能，开始检测（临时把 data-motion 设为 full），检测期间用户选择“标准”。动效选择控件没有被禁用。
- 根因：finally 仅凭 `dataset.motion === "full"` 判断仍可恢复旧值，无法区分检测设置的 full 与用户新选的 full。
- 当前复验：真实 runMotionSelfTest 配合确定性时钟，检测中显式写入 full，结束后仍被改回 calm。
- 影响：React 偏好和本机保存值为标准，实际页面仍按节能显示，直至后续触发外观重新同步；现有测试只覆盖中途改成 off 的情形。
- 修复方向：检测期间禁用会冲突的设置，或使用可识别偏好变更的版本/所有权机制；检测结束由当前偏好重新推导实际动效。

## 初始审查验证与边界

- Windows 维护逻辑：backup-maintenance、data-maintenance、upgrade-maintenance、schedule-maintenance，**54/54 通过**。运行在 Linux，不代表 Windows 原生 DACL/DPAPI 或安装态验收。
- 登录、照片、计价重试、动效、主题切换、小程序客户端与 controller 定向测试：**42/42 通过**。
- 原组件 Chromium 复现：快捷键冲突、失效分类、summary 焦点循环三项均确认；零 pageerror。
- 真实客户端/业务函数及确定性时钟：订阅响应错误、跨日退款误报、尾部停顿统计错误、动效偏好被覆盖四项均确认。
- 初次 TSX 运行误用了仓库根 JSX 配置，出现 `React is not defined`；指定 `apps/web/tsconfig.json` 后 42 项通过，未将测试启动方式错误列为产品缺陷。
- 本地旧 contracts 构建产物缺失新导出，重建 contracts/domain/UI 后继续；未更改源码或锁文件。
- 复现脚本、输出及测试日志保存在 `output/october-review/`；只使用合成输入，未访问真实顾客数据。
- 近期登录简化、维护路径、照片 CSP/查看器、取衣清空等改动的已检查路径未确认新的阻塞缺陷；这不覆盖未运行的完整 Windows 实机矩阵。

## 第 1、6、7 项修复验证（2026-10-09）

- Web 全量测试 **709/709 通过，零跳过**；包含首段无帧、尾段停顿、全程无帧、定时器延迟结束和检测期间偏好变更回归。
- 隔离 PostgreSQL 16 中，渠道结算与对账历史集成测试 **2/2 通过，零跳过**；新增断言验证跨日退款不引入前日收款，以及核对当天确实缺失的收款仍报差异。仅使用合成数据。
- 负对照：将新增回归接到原版 reconciliation 实现，准确失败于前日收款被误报 `missing_provider` 的断言；同一回归接到修复实现后通过。
- Web 构建、包体预算、服务端类型检查、改动源码 ESLint、格式检查及 `git diff --check` 通过；桌面内置 SPA 已同步，45 个资源通过校验。生产源码与测试均在文件规模预算内。
- 本地旧依赖构建产物缺失导出，已重建 platform-fs、migrate-v1；Web 默认 Node 堆不足，改用 6 GiB 堆上限构建成功，未修改项目配置或依赖锁文件。
- 验证日志保存在 `output/review-fixes-167/`。Windows 安装包与原生实机尚未复验；本次结果不表示可导入真实顾客数据或生产放行。
