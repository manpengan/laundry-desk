# Windows 桌面版 UI 实机走查与评估

> 状态：**已修复（见 §7）**（2026-08-30）
> 主责：Claude；实机走查对象为 Codex 在途 Windows 构建（QA 合成数据，门店「Codex 全功能测试」）
> 前序：[Windows 形态 findings 与构建机手册](2026-08-29-windows-port-findings-and-build-host.md)、
> [ADR-66：Windows V2 定制桌面版与宏发受控运营试点](../adr/2026-08-29-adr-66-windows-hongfa-pilot.md)
> 触发：manpengan 要求对打包后的 Windows exe 做完整 UI 功能走查并评估

---

## §1 走查方法（可复现）

SSH 会话与交互式桌面处于不同窗口站，无法直接观察或截取控制台画面。走查通过
**交互式计划任务**完成：以 session 1 用户身份注入 Win32 鼠标点击并 `CopyFromScreen` 截屏，
产物经 `winbox-copy` 取回 Mac 判读。

```
Register-ScheduledTask -Principal (New-ScheduledTaskPrincipal -UserId '74997' -LogonType Interactive)
  → powershell -EncodedCommand（EncodedCommand 不受 Restricted 执行策略限制）
  → SetCursorPos + mouse_event 注入点击
  → System.Drawing CopyFromScreen 截屏
```

**坐标坑**：`SetCursorPos` 与 `CopyFromScreen` 不在同一坐标空间，实测相差 1.5 倍
（150% DPI）。首轮点击全部偏移两个导航项，按 `点击坐标 = 截图坐标 / 1.5` 校准后正确。
后续做 Windows UI 自动化须先校准，勿直接使用截图像素坐标。

## §2 覆盖范围

10 个一级导航全部走查：工作台、开单、取衣、取送订单、生产、订单与欠款、客户、催取、
账目/对账、设置。运行环境 DESKTOP-MAN，屏幕 1707×1067，窗口铺满。

## §3 评分

| 维度 | 分 | 依据 |
| --- | --- | --- |
| 信息架构 | 8.5 | 导航序列即柜台动线（开单→取衣→生产→取送→账目），非按数据表罗列 |
| 领域建模 | 9 | 五路统一检索入口、件级流转、返工留痕、店厂交接 |
| 视觉基调 | 7.5 | 暗色克制，主色统一，卡片圆角与间距成体系 |
| **布局健壮性** | **3** | 三处元素重叠、四处右侧裁切（详见 §5 一级） |
| 一致性 | 4.5 | 金额单位跨页不统一，甚至同卡片内不统一 |
| 状态与反馈 | 6 | 空态文案优秀，但数据需手动点击加载 |
| 可访问性 | 5 | 可见标签冗长重复，焦点态对比度偏弱 |

**综合 6.0 / 10**：骨架与领域理解优秀，被表现层实现拖累。

## §4 优点

1. **领域动线正确。** 侧栏顺序就是柜台一天的工作流；「快捷取衣」置于工作台首位并支持扫码枪直接回车。
2. **账目页的口径说明。** 「实收看现金流；业绩看洗护消费。充值本金只进实收，会员余额消费只进业绩」
   直接印在界面上，四个指标卡各带一行解释。**建议以该页为全应用模板。**
3. **权限与审计界面化。** 设置页「修改需另一位店长现场复核」、取送页「门店取送功能已关闭：
   不能创建新单，既有在途订单仍可查询、推进或取消」——把服务端策略翻译成人话而非弹「无权限」。
4. **空态文案有信息量。** 「暂无可恢复挂单」「当前筛选下没有取送订单」指明了空的条件。

## §5 缺陷清单

### 一级：布局缺陷

**两个独立根因**（初判归咎于 flex-basis，隔离量测证伪，以下为实测结论）：

**根因 A —— `align-items: end` 遇上带 hint 的字段。**
[`fulfillment.css:157`](../../apps/web/src/styles/fulfillment.css) 与
[`shell.css:722/735`](../../apps/web/src/styles/shell.css) 的字段行按 `align-items: end` 底部对齐。
带 `hint` 的字段比同排字段高约 20px，底部对齐即把该字段的 `<input>` 整体上抬，下一个字段的标签
恰好落进它的垂直带内，视觉上呈现为「输入框压住标签」。隔离量测（906px 容器）：

```
条码字段高 89px（带 hint），其余 69px
条码 input top=357，分区 input top=378  →  错位 21px
「货架分区」标签 top=353，落在条码 input（357–401）区间内
```

**根因 B —— 三列网格断点存在 30px 死区。**
[`counter-ui.css:8`](../../apps/web/src/styles/counter-ui.css) 的
`minmax(220px,.8fr) minmax(360px,1.35fr) minmax(250px,.9fr)` 最小合计 830px，加两个 16px 间隙
= **862px**；而 shell 固定开销为侧栏 208px + 主区 margin/padding 80px = 288px，故三列需要
**≥ 1150px 视口**。原折叠断点却是 `max-width: 1120px`，1120–1150px 之间三列仍生效但装不下。
实测于 1138px 视口（即 1707px 屏幕 @150% DPI，国内零售 PC 最常见配置）：

```
内容盒 848px，网格需要 862px  →  溢出 14px
```

**次要因素**：`.ld-field` 在全仓无任何 flex 或宽度声明，作为 flex 子项时按 `<input>` 固有宽度
（约 193px）定宽而非分摊行宽，导致长 placeholder 与长值被裁。非重叠成因，但同样影响可读性。

| 现象 | 位置 |
| --- | --- |
| 「搜索」按钮覆盖输入框，placeholder 后半段被遮 | `.ld-customers-search`（[shell.css:722](../../apps/web/src/styles/shell.css)） |
| 「保存客户」按钮覆盖「姓名」输入框 | `.ld-customers-form`（[shell.css:735](../../apps/web/src/styles/shell.css)） |
| 「衣物条码」输入框覆盖「货架分区」标签与输入框，货架分区实际不可用 | `.ld-fulfillment__rack`（[fulfillment.css:157](../../apps/web/src/styles/fulfillment.css)） |
| 右侧内容裁切：开单页「衣物明细」表头、取衣页「加载」按钮仅余「加」字、生产页右缘 | 同源；窗口已铺满 1707×1067 仍溢出，说明 ~1280px 以下无断点 |

**影响面判断**：1080p + 150% 缩放是国内零售 PC 最常见配置，属目标场景而非边缘场景。

### 二级：设计决策

**④ 金额单位泄漏实现细节。** 界面出现「本次收款（分）」「赔付（分）」「加急固定费（分）」
「余额 ≥ 1 分」。内部以整数分计价是 CLAUDE.md 明确要求且正确；**暴露至界面是另一回事**：
店员收 15 元需输入 1500，少一个零即十倍事故。

更严重的是**同卡片内不一致**：设置页输入标签为「加急固定费（分）」，同卡片底部回显为
「加急 ¥0.00」；账目页则全程「¥145.00」。三种口径并存。

**⑤ 数据需手动加载且容器缺失。** 「订单与欠款」进页为空，须点「加载欠款」；而工作台已显示
「欠款 ¥15.00」，数据本已就绪。该页且无卡片容器，标题直接贴背景，与其余页面视觉语言脱节。

**⑥ 可见标签冗余。** 开单页「第 1 件颜色」「第 1 件品牌」「第 1 件瑕疵」「第 1 件随衣附件」
「第 1 件件级备注」——"第 1 件"重复五次，属于把无障碍标签直接当可见标签使用。

### 三级：打磨

- 工作台「实收 ¥152.00」与账目页「实收 ¥145.00」不一致（应为营业日口径差异，账目页有说明，
  但店主易困惑）
- 生产页「已选 0 件」与相邻三个按钮基线不齐
- 生产页「状态 活动件」下拉浮于输入框内部右侧，视觉上像输入框的一部分

## §6 优化建议（按性价比排序）

1. **修 `.ld-field` 的 flex 子项约束并补 1280px 断点** —— 单点改动消除全部一级缺陷
2. **金额统一以元呈现** —— 表现层收 `15.00`、提交前 ×100；DB 与契约层不动
3. **进页即加载**，保留手动刷新
4. **抽页面骨架组件** —— 固化账目页结构（卡片 + 标题 + 口径说明 + 指标网格），一致性问题成片消失
5. **可见标签去前缀** —— 显示「颜色」「品牌」，件号由分组标题承载，完整上下文留给 `aria-label`

## §7 修复记录

本文件同批提交。所有改动经隔离量测、单元测试或端到端实证，非凭截图推断。

| 缺陷 | 修法 | 验证 |
| --- | --- | --- |
| 一级 A 重叠 | 字段行改 `align-items: flex-start`；新增 `--lg-field-label-offset` token（19px 行高 + 6px 间距），无标签的按钮容器按该值补偿以落在输入框线上 | 隔离量测：三行输入框顶部对齐差 21px → **0px**，无重叠无溢出 |
| 一级 B 裁切 | 三列网格折叠断点 `1120px` → `1199px`，避开 1120–1150px 死区 | 1138px 视口：网格需求 862px → 848px，溢出 **14px → 0** |
| 一级 次要 | `.ld-field` 补 `flex: 1 1 220px; min-width: 0` | 搜索框宽度 **193px → 832px** |
| 二级 ④ 金额 | 柜台侧 10 处输入改为「元」，新增 `MoneyInput`；**对上游仍收发整数分**，提交与校验逻辑零改动 | `windows-functional` 端到端通过：应付 ¥20.00 / 已付 ¥4.00 / 余额 ¥16.00 逐项吻合 |
| 二级 ⑤ 欠款页 | 补 `ld-shell-main lg-card` 容器（`.ld-debt` 全仓无样式定义）；`useEffect` 进页即加载 | 端到端截图：容器在、数据已载、按钮为「刷新欠款」 |
| 二级 ⑥ 标签 | 可见标签去「第 N 件」前缀，完整上下文移入 `aria-label` | SSR 快照确认 `aria-label="第 1 件颜色"` 保留 |

三级中「已选 0 件」基线由一级 A 的同一改动覆盖。

### §7.1 金额迁移的影响面（三轮才收敛，值得记录）

初次提交时判断为「零影响面」，**错误**。单元测试全绿给了虚假信心——它们是 SSR 快照，只渲染不键入。
真正暴露问题的是本仓自己的 `windows-functional.spec.ts`：`fill("2000")` 本意 ¥20.00，被新字段
解释为 2000 元，断言得到 `¥2000.00`。

以编程方式填表的调用方共 **9 个 e2e 文件、25 处**，且分三种选择器形式，逐轮才找齐：

| 形式 | 处数 | 备注 |
| --- | --- | --- |
| `input[name="…"]` | 20 | 首轮脚本覆盖 |
| `[data-testid="…"]` | 2 | 次轮补，退款金额 |
| `getByLabel("…（分）")` | 3 | 末轮补，**按可见标签定位，而标签正是被改掉的那部分**，失败表现为超时而非数值错误，最难归因 |

修法：新增 `yuanText(fen)` 助手包装每处 `fill`，**常量与断言仍用整数分不变**，转换只发生在写入界面的
边界上。

**给后来者的教训**：改动可见标签或输入语义时，`grep name=` 不足以找全调用方；`getByLabel` 与
`data-testid` 两种形式必须一并排查。

### §7.2 本仓早有正确实现，问题是没有贯彻

排查中发现 **member 模块早就使用「元」输入**（`MemberRefundForm`、`MemberBonusRulesPanel` 等），
且 [`member-model.ts`](../../apps/web/src/pages/member-model.ts) 的 `yuanAmountToCents` 已实现逐位
字符串解析，注释里连反例都与本次新写的一致（`Number(text) * 100` 把 8.29 变成 828.9999…）。

因此 §5-④ 的准确表述不是「金额单位没人考虑」，而是**member 模块做对了、柜台模块没跟上**。
本次已把两处算术合并到 `@laundry/ui`：`yuanAmountToCents` 委托给共享实现，member 更严格的入参
契约（非负、至多九位整数）保留在其自身正则中。


### §7.3 全局 flex 基准的轴向陷阱（后续修正）

`9584e89` 给 `.ld-field` 加的 `flex: 1 1 220px` 是**全局**规则。在 `flex-direction: column` 的容器里，
`flex-basis` 被解释为**主轴尺寸即高度**，于是每个字段拿到 220px 的基础高度，容器随之膨胀。
Codex 在 `7006172` 修了登录页（`.ld-login__form > .ld-field { flex: 0 0 auto }`），但那是逐容器
打补丁；`.ld-counter-panel`（工作台/开单面板，3 处）与 `.ld-counter-lines`（开单行）同样中招。

隔离量测（容器 `height: auto`，与真实页面一致）：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 面板内单个字段高 | **220px** | 69px |
| `.ld-counter-panel` 总高 | **515px** | 213px |
| `.ld-counter-lines` 总高 | **448px** | 146px |

**根因修法**：把横向增长基准从 `.ld-field` 全局规则中移出，改由需要它的换行行容器自行声明。
`.ld-field` 只保留 `min-width: 0`——那才是防止 flex 行溢出的部分，与轴向无关。

横向行复验不受影响：搜索框 626/700px、客户表单 278/278、生产行输入框顶部对齐差 0px、
三行内溢出均为 0。新增 `shell.test.ts` 断言钉住该不变量：`.ld-field` 规则内不得出现
`flex` / `flex-basis` / `flex-grow`，且必须保留 `min-width: 0`。

**教训一（设计）**：给广泛复用的原子类加 `flex` 简写时，`flex-basis` 的含义取决于父容器轴向——
在 row 里是宽度、在 column 里是高度。作用域应收敛到轴向确定的容器，而不是放在原子类上。

**教训二（测量）**：本节数字曾一度报为 178px / 340px，那是 harness 给容器**硬写了高度**导致的
假象——字段在瓜分一个固定高度。真实容器是 `height: auto`，正确表现为每个字段被平铺到 220px
基准、容器累加膨胀。**复现缺陷时，harness 必须复制真实容器的尺寸约束（尤其 `height: auto`），
否则量到的是自己造出来的现象。**

### §7.4 关闭 apps/web e2e 验证缺口

`5d4920f` 收敛金额迁移调用方时，9 个 e2e 里只有 `windows-functional` 能在 Windows 构建机上实证，
其余 8 个 `apps/web/e2e/*` 需要本地 PostgreSQL + Fastify，一直只能靠「改动机械、模式一致、
类型检查通过」的间接论证。本次以项目自带路径补齐：

```
pnpm local:reset -- --confirm DELETE-laundry-desk-v2-local   # 旧卷 0019 checksum 失配
pnpm local:up -- --bootstrap                                 # 69 迁移 + 双管理员
pnpm local:web:e2e
```

**结果：22 passed，0 failed。** 覆盖 `counter-workday`、`counter-followups`、`member-benefits`、
`customer-profile`、`factory-handoff`、`operations-governance` —— 即 25 处 `fill(yuanText(...))`
中的 20 处所在规格。真实浏览器 + 真实 PostgreSQL + 真实 Fastify 走完开单、结算、收款、退款与
会员储值全流程。**金额迁移的调用方收敛至此获得直接证据。**

过程中遇到的两个非缺陷失败，记录以免后人重复排查：

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 全部 spec 加载期抛 `LAUNDRY_LOCAL_ORG_CODE is required`，末尾报 `No tests found` | 该套件需五个环境变量：三个来自 bootstrap，加 `LAUNDRY_LOCAL_ORG_CODE=local` / `LAUNDRY_LOCAL_STORE_CODE=main` | 补齐变量 |
| `notification-delivery` 期望「软件模拟模式」，实得「自动通知未启用」 | [`docker-compose.yml:57`](../../tools/compose/docker-compose.yml) 的 `LAUNDRY_NOTIFICATION_PROVIDER_MODE` 默认 `disabled`，该 spec 需要 `software_only` | 设置变量后通过；**断言正确，未修改** |

**教训（判据）**：这套 e2e 的 `exit code 1` 至少有三义——测试未加载、测试已跑但环境未配、测试已跑
且代码有问题。三者退出码相同。第一种最具误导性：会让人以为自己的改动搞挂了全部用例，进而去修
本来正确的代码。**判据必须取自输出内容（`N passed` / `N failed` / `No tests found`），不能取自
退出码。**

## §8 复现方式

在 Windows 构建机上启动打包后的 exe，然后按 §1 注入点击与截屏。构建机接入方式见
[Windows 形态 findings 与构建机手册 §2](2026-08-29-windows-port-findings-and-build-host.md)。
