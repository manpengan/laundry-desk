# @laundry/contracts

Laundry Desk V2 的跨层契约包。A1 只冻结命令/查询定义与注册边界；C1 执行总线、C4 AI 投影、C5 Policy 求值及 A2 错误信封均不在本包实现。

## A1 字段与规范映射

| 字段                                           | 规范来源                             | 消费方   | 约束摘要                                           |
| ---------------------------------------------- | ------------------------------------ | -------- | -------------------------------------------------- |
| `name` / `version`                             | 架构 §6.5、ADR-08                    | C1、Edge | 点分命令名；完整 SemVer                            |
| `description` / `description_llm` / `examples` | 架构 §6.5、ADR-05 #2                 | 后台、C4 | 人类、模型描述与 JSON 示例同源，C4 不另造语义      |
| `risk`                                         | 架构 §6.5、ADR-05 #4                 | C4、C5   | R0–R5；查询仅 R0–R2；R5 不可 AI 投影               |
| `idempotent`                                   | 架构 §6.5、ADR-04 #5                 | C1、Edge | 离线重放依赖幂等键；离线授权命令必须幂等           |
| `offline_mode`                                 | 架构 §11、ADR-04 #2/#3/#7、ADR-09 #1 | C1、Edge | `denied` / `grant` / `primary_lease`               |
| `data_classification`                          | 架构 §6.5、ADR-05 #12                | C3、C4   | secret 与 R5 独立；secret/R5 都不可 AI 投影        |
| `input_redaction` / `result_redaction`         | ADR-05 #2/#8/#12                     | C3、C4   | 输入审计/投影与结果脱敏分离；secret 输入整体不落参 |
| `size_measures`                                | ADR-09                               | C5       | 声明 batch/amount 的确定性求值方式                 |
| `hard_limits`                                  | ADR-09                               | C5       | 超限直接拒绝                                       |
| `risk_escalation`                              | ADR-09                               | C5       | R3 超阈值升级为 R4；不得高于同维硬上限             |
| `max_result_rows`                              | 架构 §6.5、A1 评审回执               | C1       | 查询结果条数硬上限；组织只能收紧                   |
| `invariants` / `sideEffects`                   | 架构 §6.5、ADR-05 #1                 | C1       | 小写点分的可执行绑定名，不是自由文本               |

## 评审问题的冻结答复

1. **查询结果限制与命令批量不是同一概念。** 查询使用必填 `max_result_rows`；命令的 batch/amount 由 `size_measures`、`hard_limits`、`risk_escalation` 三组字段表达。查询不会因为读取多行而升级风险，超过行上限必须由 C1 fail-closed。
2. **模型描述与示例均属权威命令/查询定义。** `description_llm`、可选 `examples` 与人类 `description` 同源版本化；每个示例为 `{ args, description? }`，`args` 只接受无 accessor、无环、无非有限数/BigInt/函数的 JSON 对象。C4 只读投影和裁剪，不维护第二份模型语义；示例不得包含真实或类真实凭据；secret 命令禁止 examples。
3. **输入与结果脱敏必须分开。** `input_redaction` 用于命令参数审计及 AI 入参投影，`result_redaction` 用于结果审计/模型输出；两者路径相同也必须分别声明。
4. **离线重放必须幂等。** `offline_mode !== "denied"` 与 `idempotent: false` 的组合在定义阶段拒绝。`grant` 与 `primary_lease` 只是所需授权类型，不能替代执行时授权验证。
5. **需要 `secret` 数据级别，但它不等于 R5。** `secret` 描述入参敏感性，R5 描述操作风险；secret 命令必须 `offline_mode: "denied"` 且有非空 remove-only 输入脱敏规则，查询禁止 secret。`isAiProjectableDefinition()` 同时机械排除 secret 与 R5。C3 对 secret 必须调用 `getInputAuditDisposition()`，其结果固定为 `"omit"`：审计记录不得持久化任何入参 payload，不能把局部 remove 规则当作允许记录其余字段的白名单。secret 命令也不得声明 examples；规则与禁止示例都是纵深防御，不能放入真实或占位凭据。
6. **命令版本与 contracts major 分工。** `version` 标识单个命令契约版本；任何 breaking change 同时要求提升 `@laundry/contracts` 协议 major，并按 ADR-08 保留当前与上一 major 的兼容窗口。

`invariants` 与 `sideEffects` 均存放稳定的小写点分绑定名。C1 分别把它们解析到不变量检查器和领域事件/副作用注册项；**任何一个绑定无法解析时，C1 必须在事务前 fail-closed**，不得把错拼绑定当作空数组跳过。A1 不执行这些绑定。

## 关键安全语义

- 构造器递归检查完整输入图：根与所有嵌套 object 都必须 strict，并拒绝任意层级的 `z.any()`、`z.unknown()`、`z.custom()`/`z.instanceof()`、所有 `z.lazy()`、fallback schema 及伪造解析器；日期请用 `z.date()`。Zod literal 只接受 JSON 原子值（null、boolean、string、有限 number）。
- 调用方不得提供 `kind`；无论值是否匹配，都按未知字段拒绝。
- 脱敏与规模路径使用受限 RFC 6901 JSON Pointer，拒绝根/空键、原型污染段、重复路径与祖先/后代重叠。
- 工厂返回定义带私有品牌和运行时来源标记；C1 注册前使用 `isContractDefinition()` 校验来源，并且只用异步 `parseContractInput()` 解析原始输入。两者都会复核 canonical schema 完整性；公开 `.shape` 是只读视图，Zod/Standard Schema/core 的直接解析入口均被阻断。调用方必须 `await` canonical parser，不能改用 `z.parse(definition.input, raw)`。
- 工厂会深克隆调用方提供的 schema 图；注册后对原 schema、共享 child、metadata、Date 或 RegExp 的改写不会改变 canonical 定义。输入图拒绝 `default`、`prefault`、`catch`、非法 Date 阈值及带 `g`/`y` 标志的状态型 RegExp，避免隐式 fallback 与跨解析状态。工厂不会主动写入调用方对象，但 Zod 自身 shape getter 可能在被读取时做正常的记忆化。
- 自定义 refinement/transform 回调属于同进程可信程序代码，必须是无外部可变状态的纯回调；不可变膜保护的是 schema/metadata 的结构图，不提供闭包沙箱。需要隔离不可信代码时必须放到进程边界之外，不能注册为 A1 schema。
- C4 投影前必须调用 `isAiProjectableDefinition()`；R5 或 `secret` 永远返回 `false`。
- C5 顺序固定为：求值 `size_measures` → 检查 `hard_limits` → 应用 `risk_escalation`。
- 非空 `risk_escalation` 只允许基础 R3；并存时按现行 ADR-09 要求升级线不高于硬上限。
- 组织级覆盖只能更严格；`validateStricterLimitOverride()` 合并后重新验证现行 ADR-09 良构约束，拒绝放宽、新增出厂未声明维度或使升级线高于硬上限。查询必须以 `validateStricterQueryResultLimitOverride()` 计算有效 `max_result_rows`，并在服务端 SQL/result `LIMIT` 使用它，不能先取回再由 UI 截断。

## 消费边界示例

```ts
// C1：只注册由本包工厂产生的定义。
if (!isContractDefinition(candidate)) throw new Error("untrusted contract definition");
const canonicalArgs = await parseContractInput(candidate, rawInput);

// C4：R5 或 secret 均由类型守卫和运行时判定共同排除。
if (isAiProjectableDefinition(candidate)) projectReadOnlyTool(candidate);

// C5：先验证组织覆盖，再按固定顺序求值。
const limits = validateStricterLimitOverride(
  {
    hard_limits: candidate.hard_limits,
    risk_escalation: candidate.risk_escalation,
  },
  organizationOverride,
);

// C1 query：在服务端查询前计算不可放宽的有效行数上限。
const queryLimit = validateStricterQueryResultLimitOverride(
  candidate.max_result_rows,
  organizationQueryOverride,
);
// repository.list({ limit: queryLimit.max_result_rows });
```

这些示例只说明编译边界；注册、投影与 Policy 实现分别属于 C1、C4、C5。

`defineCommand()` / `defineQuery()` 会对 `input_redaction` 与 `size_measures` 路径绑定输入
schema，并校验规模目标类型。任何 transform/pipe 下无法静态判定的声明路径在定义期即拒绝；
命令作者必须把需要脱敏或计量的字段移到可静态解析的位置。路径不存在、数组元素或数值类型
不符都必须 fail-closed。
`result_redaction` 在 A1 没有对应 output schema，C1/C3/C4 执行结果脱敏时同样必须把
missing/type mismatch 当作契约执行失败，禁止跳过规则后继续返回。PII 查询另有
`max_result_rows <= 1000` 的契约硬上限；组织/预设只能进一步收紧。1000 是 M1 的保守工具
投影初始参数，不是法规常数；在生产预设启用前须以响应大小、查询成本与脱敏负载实测重新评估。

> 配对评审待裁决：ADR-09 当前允许升级线等于硬上限，同时要求 C5 先判硬上限；若两种
> 判定都采用“超出”语义，相等会让 R4 通道不可达。A1 先按权威 ADR 接受相等，Claude
> 必须在 `contracts@v0.1.0` 冻结前明确比较语义或修订 ADR，随后同步契约测试。

## A2 命令信封、响应与错误码

| A2 对象 / 字段             | 规范来源                          | 消费方           | 冻结语义                                                         |
| -------------------------- | --------------------------------- | ---------------- | ---------------------------------------------------------------- |
| `CommandWirePayload`       | 架构 §6.5、ADR-02 #10、ADR-05 #10 | C8、C1、C4、Edge | 可从 UI/LLM/Edge 接收；不含 `actor` 或 `tenant`                  |
| `ServerCommandEnvelope`    | 架构 §4/§6.5、ADR-02 #10          | C8、C1、C3、C5   | 仅认证会话注入工厂可构造；带来源登记与私有品牌                   |
| `mode: direct` / `confirm` | ADR-05 #10                        | C1、C5           | 直执带 `args`；确认只带 `confirm_ref`，两者严格互斥              |
| `actor.via`                | 架构 §6.5、ADR-05 #1              | C3、C5           | 仅 `ui` / `ai` / `automation` / `edge_replay`，用于审计与 Policy |
| `CommandResponse`          | 架构 §6.5                         | C1、C4、UI       | 成功明确为 `execution: preview` 或 `execution: executed`         |
| `CommandError`             | 架构 §6.5、ADR-05 #4/#6           | C1、C3、C4、UI   | 固定公开文案、结构化安全详情，不可携带原始参数                   |

### 评审单 §2.1：线路载荷与服务端信封分离

`CommandWirePayloadSchema` 使用严格对象，只接受命令、版本、模式、幂等键、`dry_run`
以及该模式对应的字段。任何 `actor`、`tenant` 或未知字段都会被拒绝，不能作为自报身份
进入 C8。`direct.args` 只接受深拷贝、冻结的 JSON 对象，并递归拒绝
`__proto__`、`prototype`、`constructor`；拒绝而非静默保留是该不可信边界的 fail-closed 行为。
需要在 TypeScript 中保留已验证的 transport 类型时，消费者调用 `parseCommandWirePayload()`；
其私有品牌也阻止把带认证上下文的服务端信封错误序列化为线路载荷。

`injectAuthenticatedCommandContext()` 是从线路载荷到 `ServerCommandEnvelope` 的唯一公共
构造器。它先重新解析严格线路载荷，再解析 C8 已从服务端认证会话导出的上下文，并以未导出
的 unique-symbol 品牌和 `WeakMap` 来源登记返回冻结对象。`isServerCommandEnvelope()` 不只看
JSON 形状；展开、JSON 往返或手写同形对象都失去登记。C8 必须把浏览器、LLM 和 Edge 自报的
组织/门店忽略掉，并只把认证会话的组织、门店、员工和设备传给这个工厂。

### 评审单 §2.2：确认卡参数冻结

`mode` 是判别字段。`direct` 变体必须有 JSON `args`；`confirm` 变体必须有不透明的
UUID `confirm_ref`，且严格对象会拒绝任何 `args`。C1 在确认模式只能以 `confirm_ref`
读取 A5 持久化的 canonical args / args hash / nonce，不能回读线路参数；因此确认后无法以
同时传参或换参绕过 WYSIWYS。

### 评审单 §2.3：`via` 与 Edge 重放归属

`CommandViaSchema` 穷举 `ui`、`ai`、`automation`、`edge_replay`。C5 可按 `via + risk`
做类型收窄的 Policy 分支，C3 审计记录同一值。

`edge_replay` **不**在 A2 增加 `lease_id`、`primary_epoch` 或 `per_lease_seq`。这组三元组由
**A4 的版本化 Edge 队列信封独占**：它包住 A2 线路载荷，并按 ADR-04 #7 传递离线回放所需的
租约、epoch 与单租约单调序号。这样 A2 不会和 A4 对同一重放字段各自校验、产生冲突的真源。
三元组只用于幂等、重放、顺序和审计，不能被表述为避免物理双交付的保证。

### 评审单 §2.4：错误码与脱敏边界

| 校验链位置     | 错误码                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| Zod / 输入边界 | `VALIDATION_FAILED`                                                                                       |
| RBAC           | `PERMISSION_DENIED`                                                                                       |
| 租户或资源缺失 | `RESOURCE_UNAVAILABLE`                                                                                    |
| Policy         | `POLICY_CONFIRMATION_REQUIRED` / `POLICY_STEP_UP_REQUIRED` / `POLICY_APPROVAL_REQUIRED` / `POLICY_DENIED` |
| 不变量         | `INVARIANT_FAILED`                                                                                        |
| 同事务执行     | `TRANSACTION_FAILED`                                                                                      |
| 领域事件       | `EVENT_DISPATCH_FAILED`                                                                                   |
| 幂等键         | `IDEMPOTENCY_REPLAY_UNSUPPORTED` / `IDEMPOTENCY_CONFLICT`                                                 |

跨租户访问与资源缺失都只能返回 `RESOURCE_UNAVAILABLE` 和固定文案
`"Resource is unavailable"`；不得另加原因、资源标识或“无权访问该门店”等可探测信息。
`CommandErrorSchema` 校验文案必须匹配错误码，避免调用方拼出泄密消息。
导出的 `CommandError` 同时以 code 判别其文案字面量，故 TypeScript 调用方也不能把探测性文案
赋给 `RESOURCE_UNAVAILABLE`。

错误详情只允许安全 JSON Pointer、固定枚举原因、确认卡/审批的不透明 UUID，或固定的
step-up 方法。它没有 `args`、任意 metadata 或自由文本槽位。C1 在构造错误、日志、审计或
`tool_result` 前，必须先按 A1 `data_classification` 调用 `getInputAuditDisposition()`：`secret`
一律省略整个入参 payload，其余类别也必须应用 A1 `input_redaction`，而不是把原始 args 塞进
错误详情。C3/C4 同样不得绕过此边界。

### 评审单 §2.5：`dry_run` 成功语义

所有成功都在 `{ ok: true, data }`，但 `data.execution` 是不可省略的判别字段：`preview`
表示 C1 已完成预演、没有提交事务；`executed` 才表示实际执行成功。C4、UI 和自动化不得把
任意 `ok: true` 当作已落库。

### 评审单 §2.6：幂等键

- **格式与生成方：** 每一种模式都必须携带调用方生成的 UUID `idempotency_key`。UI/LLM 在
  发起时生成；Edge 在入队时生成并持久化同一个键，重放不得换键。
- **作用域：** C1 的持久化唯一键为 `(org_id, store_id, command, idempotency_key)`；身份和租户
  来自已品牌化服务端信封，绝不取自 wire。故同一键不能跨门店或跨命令相互影响。
- **版本与参数冲突：** `version` 不属于唯一键。C1 必须把首次请求的命令版本和 canonical args
  hash 一并绑定；后续同键但版本或 hash 不同返回 `IDEMPOTENCY_CONFLICT`，不得重新执行。
- **A1 `idempotent: true`：** 完全相同的重复请求返回已持久化的终态响应，不重跑事务或领域事件。
- **A1 `idempotent: false`：** 仍要求键以原子阻止重复投递；同键第二次返回
  `IDEMPOTENCY_REPLAY_UNSUPPORTED`，不得回放或再次执行。A1 已禁止这类命令获得离线授权。

这些是 C1 的事务性持久化责任；A2 只冻结输入形状、错误可观察性和调用方不得改变的语义。

## 冻结记录与 A6 须知

| 记录 | 冻结语义 / 维护约束                                                                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F4   | R2 的 `internal` 查询只受其出厂 `max_result_rows` 约束；强制脱敏与 1000 行硬上限只适用于 `pii`。这是当前明确语义，非遗漏。                                                                                                                      |
| F9   | `offline_mode` 采用三值而非布尔：`grant` 与 `primary_lease` 把离线授权档位写进契约，避免取衣/收款被错误降级为可自由离线、造成双花风险。`size_measures`、`hard_limits`、`risk_escalation` 也保持分离，避免把可观测、拒绝与升级三种行为重新折叠。 |
| F10  | `pii` 查询 1000 行是 M1 的保守工具投影初始参数，须在生产预设启用前以响应大小、查询成本与脱敏负载实测重估；不是法规常数。                                                                                                                        |
| F11  | `size_measures` 可无阈值，作为 C5 观测声明；未配置阈值时不得据此拒绝或升级。                                                                                                                                                                    |
| F5   | 组织不得新增出厂没有的阈值维度；否则缺少可验证的 `size_measures`，必须先改变出厂契约。                                                                                                                                                          |
| F6   | 查询在总线中固定 `offline_mode: "denied"`；Edge 的已签名本地只读缓存不经过该总线，未来若要声明离线读必须新增契约字段。                                                                                                                          |
| D1   | 只会遍历真实 Zod 图；任意嵌套的裸“伪 schema”不是可支持的输入节点，不能依赖其得到专门诊断。                                                                                                                                                      |
| D2   | 所有 `z.lazy()` 都被拒绝，而非仅拒绝“无法展开”的 lazy。                                                                                                                                                                                         |
| D3   | clone 读取调用方 `shape` getter 时，Zod 可能进行自身的正常记忆化；A1 不主动写入调用方对象，但不能把这类框架缓存表述为绝对“零对象改写”。canonical 图仍与调用方隔离。                                                                             |
| D4   | 多值 literal 不再读取会抛错的 `.value` getter；其底层 values 仍受完整性快照保护。所有构造失败（包括完整性快照）统一归一为 `ZodError`。                                                                                                          |
| F13  | canonical 图的递归深度受 JavaScript 运行时栈约束；不会静默截断，构造失败统一归一为 `ZodError`。                                                                                                                                                 |
| F14  | 公开膜的函数返回值只是兼容性观察面，不得把它视为可写 schema 句柄；所有写入与解析入口仍受膜及完整性检查保护。                                                                                                                                    |
| D5   | 非法 Date 阈值在克隆阶段拒绝；这是刻意的 canonical 化前置检查，而非 `isSafeContractInput()` 的语义分支。                                                                                                                                        |
