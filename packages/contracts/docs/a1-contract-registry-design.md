# A1 命令/查询注册表契约设计

状态：已实现，待 Claude 结对评审与契约冻结

范围：`packages/contracts`
依据：V2 架构 §6.5/§11、ADR-04 第 5/7 条、ADR-05 第 2/4/11/12 条、ADR-08 第 1 条、ADR-09 修订 1、A1 评审回执

## 1. 目标与边界

A1 提供 C1 命令总线、C4 AI Tool Registry、C5 Policy Engine 和 Edge 共同消费的唯一权威定义。构造器在注册前完成运行时校验，返回不可伪造、不可变的命令/查询定义，并保留 Zod 输入/输出类型推导。

本组不实现运行时 `Map`、重复注册、执行器、Policy 求值、脱敏执行、错误信封或领域命令；这些分别属于 C1/C4/C5/A2/A6。

## 2. 共同元数据

命令与查询均由严格 Zod schema 校验，未知字段一律失败，不提供安全默认值：

```ts
{
  kind: "command" | "query";
  name: string;
  version: string;
  description: string;
  description_llm: string;
  input: ZodObject;
  risk: "R0" | "R1" | "R2" | "R3" | "R4" | "R5";
  invariants: readonly string[];
  idempotent: boolean;
  sideEffects: readonly string[];
  offline_mode: "denied" | "grant" | "primary_lease";
  data_classification: "public" | "internal" | "pii" | "secret";
  input_redaction: readonly RedactionRule[];
  result_redaction: readonly RedactionRule[];
}
```

- `name`：至少两段的小写点分标识，如 `orders.cancel`。
- `version`：完整 SemVer。命令 breaking change 必须随 `packages/contracts` 协议 major 提升；server 按 ADR-08 同时支持当前与上一 major。
- `description` / `description_llm`：分别面向人和模型，均属于命令定义；C4 只筛选与格式化，不得补第二套语义。
- `invariants` / `sideEffects`：稳定的小写点分**可执行绑定名**，C1 分别解析到不变量检查器与领域事件/副作用注册项；不是自由文本。
- `data_classification`：`secret` 专供含 token/密钥的 R5 输入；查询不允许返回 `secret`。
- `input_redaction` / `result_redaction`：分别描述入参日志/投影和返回结果的脱敏路径，不混为一类。

两类规则共用严格结构 `{ path, strategy }`，`strategy` 仅允许
`remove | mask | last4`。`secret` 命令的输入规则只能用 `remove`；C3 还必须按
`secret` 分类默认禁止记录未脱敏入参，不能把规则数组误当成允许日志的白名单。

## 3. 命令专属元数据（ADR-09）

```ts
{
  offline_mode: "denied" | "grant" | "primary_lease";
  size_measures?: {
    batch?:
      | { kind: "array_length"; path: string }
      | { kind: "numeric_sum"; path: string; field: string };
    amount?:
      | { kind: "field"; path: string }
      | { kind: "numeric_sum"; path: string; field: string };
  };
  hard_limits?: { max_batch?: number; max_amount_cents?: number };
  risk_escalation?: { max_batch?: number; max_amount_cents?: number };
}
```

构造时强制：

1. 任一维存在阈值，则同维 `size_measures` 必须存在；
2. 同维同时存在升级线与硬上限时，升级线不得高于硬上限（`≤`），严格遵循现行
   ADR-09；相等时与“先判硬上限”的组合会让 R4 通道不可达，必须由 Claude 在
   `contracts@v0.1.0` 冻结前裁定比较/执行语义，A1 不越权修改 ADR；
3. 所有数量与金额均为正安全整数；金额始终用分；
4. `offline_mode !== "denied"` 时 `idempotent` 必须为 `true`；声明授权档位不等于持有授权，C1/Edge 仍须验证当前 grant/Primary lease；
5. 非空 `risk_escalation` 仅允许在基础 `risk === "R3"` 的命令上声明；
6. `data_classification === "secret"` 时必须 `risk === "R5"`、`offline_mode === "denied"`，且 `input_redaction` 非空并全部使用 `remove`。

C5 的固定顺序是：按 `size_measures` 求值 → 超 `hard_limits` 直接拒绝 → 超 `risk_escalation` 将 R3 升至 R4。

包导出 `validateStricterLimitOverride(factory, override)`。两参数分别是出厂与组织级
`{ hard_limits?, risk_escalation? }`，返回不可变的合并后有效配置。覆盖值只能小于等于
同组、同维出厂线，且不得新增出厂未声明的组或维度。合并后再次执行“升级线不得高于
硬上限”的现行良构校验，避免只收紧硬上限反而违反 ADR-09；违反时抛
`ZodError`。

## 4. 查询专属 fail-closed 约束

查询与命令分立 schema：

- `kind` 固定为 `query`；
- `risk` 仅 R0–R2；
- `idempotent` 固定为 `true`；
- `invariants`、`sideEffects` 固定为空；
- `offline_mode` 固定为 `denied`；
- `max_result_rows` 为必填正安全整数，表达结果条数硬上限；PII 查询不得超过 1000，组织/预设只能进一步收紧；
- `data_classification` 仅 `public | internal | pii`；PII 查询必须是 R2 且 `result_redaction` 非空。

Edge 离线缓存读取不重放 server 查询，也不经过命令/查询总线；它读取已签名/已同步的本地只读投影。因此查询固定 `denied` 与架构 §11 的缓存窗口不冲突。

## 5. 安全 JSON Pointer

两类脱敏路径与 `size_measures.path` 共用受限 RFC 6901 JSON Pointer：

- 必须指向至少一个非空字段段；空串根指针、`/` 空键、`//` 均拒绝；
- 原始 `~`、`/` 分别编码为 `~0`、`~1`；
- 解码后的 `__proto__`、`prototype`、`constructor` 段拒绝；
- 同一规则数组不得出现重复路径，也不得同时包含祖先与后代路径，避免执行顺序改变脱敏结果。

`numeric_sum.field` 是 `path` 所指数组元素上的**单个 own-property 键**，仅允许小写
snake_case 标识，且显式拒绝 `__proto__`、`prototype`、`constructor`；它不是嵌套
路径。需要嵌套时必须把数组定位精确到包含数值字段的元素集合，不得另立寻址语法。

A1 对能静态解析的命令输入脱敏/规模路径绑定 input schema，并校验 array/number 目标类型；
transform 等无法静态判定的路径由执行方在 canonical args 上复核。C1/C3/C4/C5 实现
walker 时必须只遍历 own properties，不允许原型链访问。任何 missing path、数组元素或
数值类型不符都必须 fail-closed，不得静默跳过。`result_redaction` 因 A1 尚无 output schema，
由 C1/C3/C4 在结果产生后执行相同的 fail-closed 检查。

## 6. 输入 schema、品牌与不可变性

- `input` 必须是真实的严格 `ZodObject`；完整 schema 图中所有嵌套 object 也必须 strict，任意层级均拒绝 `z.any()`、`z.unknown()`、无法静态展开的 `z.lazy()`、隐式 fallback 的 `default`/`prefault`/`catch`、非法 Date 阈值，以及带 `g`/`y` 标志的状态型 RegExp；同时拒绝数组根、strip/passthrough object 和伪造 `parse` 对象。
- 构造器在返回前深克隆完整 Zod 定义图、checks、metadata 与无状态 RegExp，得到与调用方
  对象不共享可变容器的 canonical schema。shape accessor 只读取一次，并验证/注册同一份
  快照；调用方随后替换原 shape、共享 child、metadata、RegExp 或 `_zod` 不会改变已注册
  定义。公开 `definition.input` 是递归只读膜，阻断 Zod/Standard Schema/core 的直接解析
  与任何变更入口；构造器另记录 canonical schema 图、prototype、metadata 与 parse core
  完整性，膜被绕过或包内对象遭篡改时 `isContractDefinition()` 与
  `parseContractInput()` 都 fail-closed。C1 必须 `await parseContractInput()` 取得 canonical
  args，不得自行调用公开 schema 的同步或异步 parse 入口。
- 用户自定义 refinement/transform 回调是同进程可信程序代码，必须保持纯函数且不得读取
  外部可变状态。结构深克隆与只读膜无法快照 JavaScript 闭包，因此 A1 不把 schema 注册
  边界宣称为不可信代码沙箱；不可信扩展必须在独立进程边界隔离。
- 调用方不得提供 `kind`；匹配或冲突的 `kind` 都作为未知字段抛 `ZodError`，构造器不静默纠正。
- 返回定义、元数据数组、规则、规模声明和阈值对象均深冻结；不修改调用者对象。
- 定义带非导出唯一品牌和运行时 WeakMap 注册记录。类型层无法直接伪造；包导出 `isContractDefinition()` 供 C1 在注册边界同时验证工厂来源与 schema 完整性。
- `InferContractInput<T>` / `InferContractOutput<T>` 分别保留解析前后类型。

## 7. R5 不投影机制

包导出 `isAiProjectableDefinition()` 类型守卫，唯一判据是 `risk !== "R5"`。C4 必须先通过该守卫再投影；契约测试断言 R5 返回 `false`。`secret` 仅允许 R5 命令，因此同时被排除。

## 8. 错误语义与测试

所有构造/覆盖校验失败统一抛原始 `ZodError`；A2 再定义跨边界错误信封。测试必须先红后绿并覆盖：

- 每字段缺失/非法、未知字段、caller `kind`、SemVer、绑定名和安全 pointer；
- ADR-09 两条良构约束的 batch/amount 两维组合，以及等线接受与 R3-only；
- grant/Primary lease 与幂等交叉约束；
- 查询结果上限、PII R2+脱敏；
- stricter override 正反例与合并后二次良构校验；
- R5 投影排除、品牌 guard、递归严格 object 输入、只读膜与 caller/canonical 图隔离；
- 深冻结、判别联合、input/output 推导、根级 refinement 与 metadata 保留；
- fallback schema 与状态型 RegExp 拒绝、异步 transform 经 canonical parser 正确解析；
- C1/C4/C5 各一个编译通过的消费样例。

包级覆盖率不少于 70%，并运行 lint、strict typecheck（含依赖声明，`skipLibCheck: false`）、test、build 与根级 `workspace:check`。依赖变化同步两份 lockfile。

## 9. 非目标

- 不实现 C1 注册 `Map`、重复名/版本冲突或校验链。
- 不执行规模求值、阈值判定、脱敏或 AI 投影。
- 不定义 A2 错误码，也不落 A3–A7 业务 schema。
