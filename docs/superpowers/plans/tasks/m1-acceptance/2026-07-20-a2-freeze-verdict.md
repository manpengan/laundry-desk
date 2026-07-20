# A2 冻结评审结论

> 评审：Claude（设计与门禁）　日期：2026-07-20　对象：[PR #51](https://github.com/manpengan/laundry-desk/pull/51) @ `codex/m1-a2-envelope`
> 评审基准：[A2 评审单](a2-envelope-and-errors.md)　上游：架构 §6.5、ADR-02 #10、ADR-05 #10/#11、ADR-08 #1
> 核验方式：三个源文件逐行读 + 四个测试文件用例名与断言实体核对 + PR 描述六点逐条对照 + README 冻结记录比对

## 结论：**通过**（0 必修、1 记录）

评审单 §2.1–§2.6 **全部满足，且全部以机制实现而非命名约定**；§5 的两条否决条件（§2.1 或 §2.2 仅靠文档约定）均不触发。可冻结，A4 可开工。

## 一、逐条对照

### §2.1（P0）线路载荷 vs 命令信封类型不可互构 —— **满足**

- 两个私有品牌：`declare const COMMAND_WIRE_PAYLOAD_BRAND: unique symbol`、`SERVER_COMMAND_ENVELOPE_BRAND`，配 `registeredServerEnvelopes = new WeakMap<object, true>()` 来源登记——正是评审单点名的 A1 手法。
- 线路载荷**根本没有 `actor` / `tenant` 字段**。注入时 `Object.freeze({ ...context.actor })` 取拷贝而非调用方引用。
- 注释固化语义：「C8 ignores self-reported identity and injects authenticated context into a separate branded envelope」「it never exposes an unbranded construction path」。
- 负向断言存在：`wire-payload.test.ts` 的 `rejects self-reported actor or tenant context on the wire`。

### §2.2（P0）`args` 与 `confirm_ref` 互斥 —— **满足**

`z.discriminatedUnion("mode", [Direct, Confirm])`，两支各自 `.strict()`：`direct` 携 `args`、`confirm` 携 `confirm_ref`，同时提交被 strict 拒绝。断言实体：`rejects a payload that combines frozen confirmation and new arguments`。ADR-05 #10 的「确认后换参数」通道在契约层关闭。

### §2.3 `via` 四值与 `edge_replay` 三元组归属 —— **满足**

`CommandViaSchema = z.enum(["ui", "ai", "automation", "edge_replay"])`，与 §6.5 一致。

三元组归属**明确未沉默**：PR 描述 §2.3「`edge_replay` 的 `lease_id + primary_epoch + per_lease_seq` 已明确由 A4 版本化队列信封独占」。经核 A2 三个源文件中 `lease` / `epoch` / `seq` 出现均为 0 处，与该声明一致。此归属与 [A4 评审单](a4-edge-bridge-protocol.md) §2.6 要求的「A4 给出最终归属」衔接，两边都不收的风险已消除。

### §2.4 错误码表三项硬要求 —— **全部满足**

**1. 不泄漏存在性。** 码表中**没有 `NOT_FOUND`**，跨租户与缺失同归 `RESOURCE_UNAVAILABLE`。更关键的是机制：`createErrorSchema` 里 `message: z.literal(message)` 把**文案锁死在码上**——「无权访问该门店订单」一类可探测措辞在类型层不可表达。负向断言存在（以 `"Order 42 exists in another tenant"` 撞构造，被拒）。

**2. 校验链全段覆盖 + Policy 四结局可区分。**

| 校验链段（§6.5） | 错误码 |
|---|---|
| Zod | `VALIDATION_FAILED` |
| RBAC | `PERMISSION_DENIED` |
| 租户 | `RESOURCE_UNAVAILABLE` |
| Policy | `POLICY_CONFIRMATION_REQUIRED` / `POLICY_STEP_UP_REQUIRED` / `POLICY_APPROVAL_REQUIRED` / `POLICY_DENIED` |
| 不变量 | `INVARIANT_FAILED` |
| 事务 | `TRANSACTION_FAILED` |
| 领域事件 | `EVENT_DISPATCH_FAILED` |
| 幂等（额外） | `IDEMPOTENCY_REPLAY_UNSUPPORTED` / `IDEMPOTENCY_CONFLICT` |

Policy 段四种结局各占独立码，AI Runtime 可据以走 §9.4 分支（ADR-05 #4/#11）。

**3. 错误载荷受脱敏约束 —— 做法强于评审单要求。** 评审单问的是「如何与 A1 的 `data_classification` / `input_redaction` 联动」，实现选择的是**把泄漏通道结构性移除**：`detail` 是受限判别联合，仅五种形态——`{kind:'field', path: JsonPointer}`、`{kind:'reason', reason: 四值枚举}`、`{kind:'confirmation', confirm_ref}`、`{kind:'step_up', methods}`、`{kind:'approval', approval_ref}`。raw args 与自由文本槽位**不可表达**，故 C1/C3 无从把 PII/secret 泄进日志、审计或 `tool_result`。联动不再必要，因为通道本身不存在。

### §2.5 `dry_run` 响应可区分 —— **满足**

`z.discriminatedUnion("execution", [preview, executed])`，注释固化：「`execution: "preview"` is the sole success shape for `dry_run`; callers must not infer a commit from a successful preflight response」。

### §2.6 `idempotency_key` 作用域 —— **满足**

`IdempotencyKeySchema = z.uuid()`，TSDoc 注明「caller-generated UUID used by C1's **tenant-scoped** idempotency store」。README 另冻结 canonical hash / version 冲突与 idempotent / non-idempotent 的重试语义。断言：`requires a caller-generated UUID idempotency key`。

## 二、超出评审单要求的部分（据实记录）

- **原型污染防御**：`containsDangerousArgumentKey` 递归拒绝任意层级的 `__proto__` / `prototype` / `constructor`，另有 `rejects prototype-related direct argument keys` 断言。评审单未要求。
- **`WireArgumentsSchema` 深拷贝**：`copyJsonMetadata` 产出惰性 JSON 记录，杜绝调用方保留可变引用后篡改已解析载荷。
- **A1 遗留六点一并回清**：README「评审问题的冻结答复」逐条覆盖 A1 评审单 §3.3–§3.6 与 version/major——`max_result_rows` 补入（A1 F8）、`description_llm` 单列、入参与结果脱敏分离、`offline_mode !== denied ⟹ idempotent` 定义期拒绝、**secret 与 R5 独立**（与 [F1 裁定](2026-07-20-f1-secret-risk-ruling.md)一致）。
- **A1 的 F9 已闭合**：README:181 补记「`offline_mode` 采用三值而非布尔：`grant` 与 `primary_lease` 把离线授权档位写进契约，避免取衣/收款被错误降级为可自由离线、造成双花风险」，并说明三字段分离的理由。F9 要求的「留档以免后人简化回布尔」已达成。

## 三、记录项（不阻塞冻结）

### D1 一条断言恒真（红线 3 的边界情形）

`responses.test.ts:26–30`：

```js
const missing = createCommandError("RESOURCE_UNAVAILABLE");
const crossTenant = createCommandError("RESOURCE_UNAVAILABLE");
expect(missing).toEqual(crossTenant);
```

同一构造调用两次自然相等，**该断言无论实现如何都不会红**，不证明「跨租户与缺失不可区分」。真正的保证来自两处：码表无 `NOT_FOUND`、`message: z.literal()` 锁死文案——这两处都另有可失败的断言守着，故安全性无碍，属测试表达问题。

建议：改为从两条不同语义入口（缺失路径与跨租户路径）各自构造后比对，或直接删除、只留那条以泄漏文案撞构造的负向断言。A3 起可复用同一判准。

## 四、证据核验（红线 1）

PR 描述的验证声明与实测一致，且**主动披露了一处限制**：

> 根级 `pnpm run workspace:check` 在 pnpm 的 ignored-builds 安装前置阶段中止，未进入任何 workspace lint/typecheck/test/build；未更改 allowBuilds、lockfile 或依赖配置。包级等价验证如上已完整执行。

该环境问题 [A1 冻结结论](2026-07-20-a1-freeze-verdict.md)§六.3 已记录为全队待解（`ERR_PNPM_IGNORED_BUILDS`），非本 PR 缺陷。声明中未把包级验证冒充为根级通过，红线 1 合规。CI 侧 `build` 与 `workspace-check` 双绿，证据已补足。

测试面：`wire-payload` 7 例 / `server-envelope` 5 例 / `responses` 5 例 / `envelope-types` 4 例，覆盖评审单 §3 通过标准的每一条。

## 五、放行与后续

1. **A2 冻结**——按[放行语义](README.md)，本组通过即宣告冻结、下游立即可依赖，无须等 tag。
2. **通知 Gemini**：C7 platform 的两个前置里 A2 已就位，仍等 A6（首批命令定义）。其 C7 现挂在 `feat/m1-c7-platform`，重接时按本组信封与错误码落地。
3. **A4 可继续**——评审单已在 main，其 §2.6 的三元组归属与本组 §2.3 的声明已对齐。
4. **tag `contracts@v0.1.0` 仍待 A1–A7 全组通过后打**；A1 的 F7（`transform` 下声明路径静默跳过）与 F12（`z.literal([...])` 无法注册）仍未修，其中 **F7 已按 [F1 裁定](2026-07-20-f1-secret-risk-ruling.md)提前为 A6 开工前必修**。
