# A1 命令注册表契约设计

状态：实现完成，待 Claude 结对评审

范围：`packages/contracts`

依据：V2 架构定稿、ADR-02、ADR-04、ADR-05、Codex 任务书 §3 A1

## 1. 目标

A1 提供命令总线、Policy Engine、AI Tool Registry 与 Edge 桥共同消费的命令/查询定义契约。每个定义必须在构造时完成运行时校验，并保留输入 Zod schema 的静态类型推导能力。

本阶段只定义契约和构造器，不实现注册表存储、重复注册检测、执行器、权限校验、错误码或业务命令。

## 2. 对外 API

包导出两类只读定义：

- `defineCommand(definition)`：有状态业务操作，可声明 R0–R5。
- `defineQuery(definition)`：只读查询，强制 R0–R2、幂等、不可离线执行且无副作用。

两类定义共同包含：

```ts
{
  kind: "command" | "query";
  name: string;
  version: string;
  description: string;
  input: ZodType;
  risk: "R0" | "R1" | "R2" | "R3" | "R4" | "R5";
  invariants: readonly string[];
  idempotent: boolean;
  sideEffects: readonly string[];
  offline_allowed: boolean;
  data_classification: "public" | "internal" | "pii";
  max_batch: number;
  result_redaction: readonly ResultRedactionRule[];
}
```

`input` 由泛型构造器单独持有，并在构造时验证为当前包所使用的真实 Zod schema；其余可序列化元数据使用 Zod 严格对象 schema 校验。这样既避免将 Zod schema 伪装成可序列化数据，也避免只靠 TypeScript 类型而缺失运行时边界校验。仅提供同名 `parse`/`safeParse` 方法的伪造对象必须被拒绝。

## 3. 命名与字段约束

- `name`：稳定的小写点分标识，至少包含一个领域段和一个动作段，例如 `orders.create`。
- `version`：完整 SemVer，例如 `1.0.0`；支持合法的 prerelease/build metadata。
- `description`：去除首尾空白后不能为空。
- `invariants`、`sideEffects`：稳定的小写点分标识数组，元素不得重复。
- `risk`：命令允许 R0–R5；查询只允许 R0–R2。
- `data_classification`：仅允许 `public`、`internal`、`pii`。
- `max_batch`：必填正整数；单项命令/查询写 `1`，批量入口写允许的硬上限。契约不允许“无限批量”。
- `result_redaction`：必填字段；无脱敏时为空数组，否则为有序规则数组。

六个安全元数据字段 `risk`、`idempotent`、`offline_allowed`、`data_classification`、`max_batch`、`result_redaction` 不提供默认值，缺少任一字段都必须在定义阶段失败。

`max_batch` 是总线可执行的硬上限。C5 对已通过输入 schema 的实际参数计算批量规模，超出 `max_batch` 直接拒绝；未超硬上限时仍可由命令专属参数阈值触发 R3→R4。A1 不定义通用的“批量字段路径”，因为不同命令可能由数组长度、数量合计或金额/件数联合决定；该计算属于 B4/C5 的纯风险判定函数与命令策略。

## 4. 查询的 fail-closed 不变量

查询契约不是命令契约的宽松别名，而是独立的判别联合分支：

- `kind` 固定为 `query`；
- `risk` 只能是 R0、R1、R2；
- `idempotent` 固定为 `true`；
- `offline_allowed` 固定为 `false`；
- `sideEffects` 固定为空数组。

任何不满足上述条件的查询定义在构造时抛出 `ZodError`，不得自动降级或修正。

`offline_allowed` 仅声明命令具备进入离线队列的候选资格。它不授予权限，也不替代 staff×device offline grant、Primary lease、权限版本检查、当前权限重校验或 replay 仲裁；这些由 A4/C1/C5 及 Edge/服务端实现共同强制。

## 5. 结果脱敏规则

`ResultRedactionRule` 结构为：

```ts
{
  path: string;
  strategy: "remove" | "mask" | "last4";
}
```

`path` 使用非空 RFC 6901 JSON Pointer，例如 `/customer/phone`。原始 `~` 和 `/` 必须分别编码为 `~0` 和 `~1`。规则顺序有语义并原样保留；本阶段只校验规则，不执行脱敏。

## 6. 不可变性与错误语义

- 构造器通过 Zod `parse` 创建元数据副本，避免调用者后续修改输入数组污染已定义契约。
- 返回定义、元数据数组及脱敏规则均冻结并以只读类型导出。
- 输入必须通过真实 Zod schema 的运行时身份检查，再作为不可变 schema 对象保留，以维持 `z.input`/`z.output` 推导。
- 所有定义错误统一抛出原始 `ZodError`；A2 再定义跨边界错误信封与稳定错误码。
- 不接受未知字段，防止拼写错误或未评审的安全元数据被静默忽略。

## 7. 类型推导

构造器保留具体输入 schema 类型，并导出辅助类型：

- `InferContractInput<TDefinition>`：命令/查询接受的输入类型。
- `InferContractOutput<TDefinition>`：输入 schema 解析后的输出类型。

这允许 C1 在执行前调用同一 schema 校验，并让业务处理器获得精确类型，不使用 `any` 或不必要的类型断言。

## 8. 验证策略

测试先于实现，并覆盖：

1. 合法命令和查询的构造、判别联合与输入类型推导；
2. 六个安全字段逐一缺失时失败；
3. 伪造的输入 schema，以及非法名称、SemVer、批量上限和 JSON Pointer 失败；
4. 查询声明 R3–R5、非幂等、允许离线或副作用时 fail-closed；
5. 未知字段失败；
6. 调用方修改原始数组后，已构造定义保持不变；
7. 返回对象和嵌套元数据在运行时被冻结。

完成前运行 contracts 单包的格式、lint、类型检查、测试、构建，以及根级 `workspace:check`。如新增依赖，同时更新 `package-lock.json` 与 `pnpm-lock.yaml`。

## 9. 非目标

- 不实现 C1 的 `Map`、重复注册冲突、执行流水线或事务边界。
- 不实现 A2 错误码和响应信封。
- 不实现 A3 租户/RLS、A4 Edge 协议或 A5/A6/A7 具体 schema。
- 不实现结果脱敏算法、Policy 判定、AI 投影或离线队列行为。
