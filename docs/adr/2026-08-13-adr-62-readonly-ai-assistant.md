# ADR-62：有来源的有界只读 AI 助手

- 状态：**Proposed**
- 日期：2026-08-13
- 范围：Stage 4.5 Item 15
- 依赖：[ADR-05](2026-07-19-adr-05-ai-command-policy-approval.md)、[ADR-58](2026-08-13-adr-58-bounded-ai-streaming-runtime.md)、[ADR-59](2026-08-13-adr-59-ai-safety-metering.md)

## 背景

Item 14 只允许合成 `synthetic.lookup`，不读取业务数据。柜台与 Owner 需要经营问答、
订单/顾客检索和规程排障，但不得因自然语言入口绕过现有 tenant、RBAC、query
schema、结果上限和隐私边界。本 Item 也不得提前实现 provider、解密 key 或外网调用。

## 决策

### 1. 三个闭合只读工具

Runtime 在 Item 15 模式只向 provider-neutral port 暴露：

- `business.summary`：复用 `stats.day.summary@0.3.0`，仅 `accounting_read` 权限可用。
- `records.search`：按严格 scope 复用 `order.lookup@0.1.0` 或 `customer.search@0.2.0`，
  需 `customer_read`，最多 10 个候选。
- `procedure.troubleshoot`：只读取随版本发布的固定规程，不接受文件路径、URL 或
  远程文档地址，需 `ai_use`。

参数是 discriminated union 的 strict Zod schema。未知 tool、多余字段、自由 SQL、任意
URL/header、写命令和未授权 scope 全部失败关闭。

### 2. 只经既有 Query Bus 读取

业务两类工具调用现有 `executeQuery`，因此继续执行契约 Zod、当前会话 RBAC、
`REPEATABLE READ READ ONLY`、参数化 SQL 和 `app.org_id/store_id/staff_id` transaction-local
GUC。工具不拥有数据库连接字符串、不接受 SQL 文本，也不能调用 Command Bus。

### 3. 脱敏、来源与筛选条件

订单/顾客结果只返回有界投影：手机号只留末四位，姓名只留首字，备注、地址、
凭据和 secret 不进入 tool result。每个成功结果必须带非空 `sources`、显式安全
`filters`和 `result_count`；查询原始线索在返回筛选中统一标记 `redacted`。

### 4. 时间、结果和工具次数上限

Item 15 单 turn 最多三次业务工具，每次 800ms，每次最多 10 条结果；同时保留
Item 14 的 15s 总 deadline、1024 output tokens、32768 bytes 和 256 events。超限只产生
封闭错误码，不切换工具、provider 或网络通道。

### 5. Metadata-only audit 与 UI

0067 仅扩展 tool event/attempt 闭集。Closed `SECURITY DEFINER` function 复核 auth session
与 tenant GUC，只存 tool name、step、outcome、duration、result/source/filter count 和请求/
结果 hash；不存 args、result、prompt、PII、provider、URL、header 或 key。

柜台顶栏和 Owner 经营台共用 AI 抽屉，明确显示三类问题、默认脱敏及来源/筛选
承诺。仍只渲染纯文本，会话切换和关闭会 abort。

## 否决的备选

- 让模型生成 SQL：无法在契约、RBAC 和结果上限前封闭数据面。
- 调用普通 HTTP/URL 工具：会引入 SSRF、header/credential 泄露和未授权数据源。
- 直接将 query result 传给模型：会绕过 PII 最小投影与结果数限制。
- 在 audit 中保存问题和结果：会把业务语义和 PII 复制到长期审计面。

## 后果

- 本 Item 仅证明 provider-neutral deterministic fake 下的三个只读能力，不声明任何
  真实 provider、key、外网、模型或生产 AI 已验收。
- 0067 填补 0065→0066→0067→0068→0069 连续迁移；本 Item 不修改 0068/0069。
- 任何写工具、自动化、provider adapter 或新业务查询都需独立 ADR 与门禁。
