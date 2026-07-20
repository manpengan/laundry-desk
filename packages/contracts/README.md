# @laundry/contracts

Laundry Desk V2 的跨层契约包。A1 只冻结命令/查询定义与注册边界；C1 执行总线、C4 AI 投影、C5 Policy 求值及 A2 错误信封均不在本包实现。

## A1 字段与规范映射

| 字段                                   | 规范来源                             | 消费方   | 约束摘要                                     |
| -------------------------------------- | ------------------------------------ | -------- | -------------------------------------------- |
| `name` / `version`                     | 架构 §6.5、ADR-08                    | C1、Edge | 点分命令名；完整 SemVer                      |
| `description` / `description_llm`      | 架构 §6.5、ADR-05 #2                 | 后台、C4 | 人类和模型描述同源，C4 不另造语义            |
| `risk`                                 | 架构 §6.5、ADR-05 #4                 | C4、C5   | R0–R5；查询仅 R0–R2；R5 不可 AI 投影         |
| `idempotent`                           | 架构 §6.5、ADR-04 #5                 | C1、Edge | 离线重放依赖幂等键；离线授权命令必须幂等     |
| `offline_mode`                         | 架构 §11、ADR-04 #2/#3/#7、ADR-09 #1 | C1、Edge | `denied` / `grant` / `primary_lease`         |
| `data_classification`                  | 架构 §6.5、ADR-05 #12                | C3、C4   | `secret` 只允许 R5 命令；查询禁止返回 secret |
| `input_redaction` / `result_redaction` | ADR-05 #2/#8/#12                     | C3、C4   | 输入审计/投影与结果脱敏分离                  |
| `size_measures`                        | ADR-09                               | C5       | 声明 batch/amount 的确定性求值方式           |
| `hard_limits`                          | ADR-09                               | C5       | 超限直接拒绝                                 |
| `risk_escalation`                      | ADR-09                               | C5       | R3 超阈值升级为 R4；不得高于同维硬上限       |
| `max_result_rows`                      | 架构 §6.5、A1 评审回执               | C1       | 查询结果条数硬上限，不复用批量命令语义       |
| `invariants` / `sideEffects`           | 架构 §6.5、ADR-05 #1                 | C1       | 小写点分的可执行绑定名，不是自由文本         |

## 评审问题的冻结答复

1. **查询结果限制与命令批量不是同一概念。** 查询使用必填 `max_result_rows`；命令的 batch/amount 由 `size_measures`、`hard_limits`、`risk_escalation` 三组字段表达。查询不会因为读取多行而升级风险，超过行上限必须由 C1 fail-closed。
2. **`description_llm` 属于权威命令定义。** 它与人类 `description` 同源版本化；C4 只读投影和裁剪，不维护第二份模型描述。
3. **输入与结果脱敏必须分开。** `input_redaction` 用于命令参数审计及 AI 入参投影，`result_redaction` 用于结果审计/模型输出；两者路径相同也必须分别声明。
4. **离线重放必须幂等。** `offline_mode !== "denied"` 与 `idempotent: false` 的组合在定义阶段拒绝。`grant` 与 `primary_lease` 只是所需授权类型，不能替代执行时授权验证。
5. **需要 `secret` 数据级别。** `secret` 仅允许 R5、`offline_mode: "denied"` 且有输入脱敏规则的命令；查询禁止 `secret`，R5 也被 AI 投影守卫排除。
6. **命令版本与 contracts major 分工。** `version` 标识单个命令契约版本；任何 breaking change 同时要求提升 `@laundry/contracts` 协议 major，并按 ADR-08 保留当前与上一 major 的兼容窗口。

`invariants` 与 `sideEffects` 均存放稳定的小写点分绑定名。C1 分别把它们解析到不变量检查器和领域事件/副作用注册项；A1 不执行这些绑定。

## 关键安全语义

- 构造器只接受严格 `ZodObject` 根输入，拒绝 `z.any()`、strip/passthrough object 和伪造解析器。
- 调用方不得提供 `kind`；无论值是否匹配，都按未知字段拒绝。
- 脱敏与规模路径使用受限 RFC 6901 JSON Pointer，拒绝根/空键及原型污染段。
- 工厂返回定义带私有品牌和运行时来源标记；C1 注册前使用 `isContractDefinition()` 校验来源。
- C4 投影前必须调用 `isAiProjectableDefinition()`；R5 永远返回 `false`。
- C5 顺序固定为：求值 `size_measures` → 检查 `hard_limits` → 应用 `risk_escalation`。
- 非空 `risk_escalation` 只允许基础 R3；并存时按现行 ADR-09 要求升级线不高于硬上限。
- 组织级覆盖只能更严格；`validateStricterLimitOverride()` 合并后重新验证现行 ADR-09 良构约束，拒绝放宽、新增出厂未声明维度或使升级线高于硬上限。

## 消费边界示例

```ts
// C1：只注册由本包工厂产生的定义。
if (!isContractDefinition(candidate)) throw new Error("untrusted contract definition");

// C4：R5 由类型守卫和运行时判定共同排除。
if (isAiProjectableDefinition(candidate)) projectReadOnlyTool(candidate);

// C5：先验证组织覆盖，再按固定顺序求值。
const limits = validateStricterLimitOverride(
  {
    hard_limits: candidate.hard_limits,
    risk_escalation: candidate.risk_escalation,
  },
  organizationOverride,
);
```

这些示例只说明编译边界；注册、投影与 Policy 实现分别属于 C1、C4、C5。

> 配对评审待裁决：ADR-09 当前允许升级线等于硬上限，同时要求 C5 先判硬上限；若两种
> 判定都采用“超出”语义，相等会让 R4 通道不可达。A1 先按权威 ADR 接受相等，Claude
> 必须在 `contracts@v0.1.0` 冻结前明确比较语义或修订 ADR，随后同步契约测试。
