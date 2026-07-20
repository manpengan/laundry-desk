# A1 冻结评审结论

> 评审：Claude（设计与门禁）　日期：2026-07-20　对象：PR #43 @ `9620618`
> 评审基准：[A1 评审单](a1-command-registry.md)　设计依据：[ADR-09](../../../../adr/2026-07-20-adr-09-command-metadata-precision.md)（含修订 1、2）
> 核验方式：独立复现测试与覆盖率（含变异抽查）+ README 安全声明逐条对代码 + 文档与实现一致性核验 + Claude 亲自做 spec 语义比对

## 结论：**通过**（6 项必修、3 项须补文档、14 项记录）

评审单 §4 的十项通过标准**逐条满足**；§6 的两条否决条件（字段缺失 / §3.1–§3.2 未按 ADR-09 落地）均不触发；防篡改核心机制经全量 fuzz 无绕过。下列 F/D 项是精确化与文档订正，不构成退回理由——但 **F1 必须在 A6 开工前裁定**，**F7 与 F12 必须在打 tag 前修**。

> **防篡改层已过独立绕过复审**：对 978 个图内对象 + 24 条原型做全量变异 fuzz（加属性、改值、换对象/函数、Set/Map/Date/RegExp 内容变更），**零漏检**；所有对外可得引用均为受保护代理，无一原始 schema 图对象泄漏。`parseContractInput` 的异步窗口真实存在，但实测无可用原始句柄可利用（调用方可控 getter 在解析中途篡改，全部抛 `TypeError: Contract input schema is read-only`）。**未发现可利用绕过路径。**

## 一、证据核验（红线 1 与红线 3）

Codex 的声明**全部属实**，在 Codex 工作树只读复现并在独立工作树重跑：

| 声明 | 复现结果 |
|---|---|
| 258/258 测试 | 一致（12 文件全绿，两个环境均为 258/258） |
| 90.58% stmts / 87.33% branches | 一致（异环境 branches 有 ±0.04pp 的 v8 抖动，不构成失实） |
| typecheck / lint 零错零警 | 一致；lint 脚本自带 `--max-warnings=0`，exit 0 即真零警告 |
| 离线 frozen 安装 | 属实 |
| Date 篡改 / Invalid Date 回归测试 | 真实存在且可证伪 |

**可证伪性抽查**：5 处变异（改严阈值比较、去掉 secret⇒R5、删 `primary_lease` 枚举值、拆膜层 Date 守卫、删 Invalid Date 抛错）**全部变红**，覆盖 4 个源文件与 4 个测试文件，报错精确指向对应断言。其中把校验改**严**也被抓到，说明边界是精确锁定而非单向宽松。红线 3 通过。

红线 2（rebase）、红线 4（双锁文件）均通过；改动未越出 `packages/contracts`。

## 二、必修项

### F1（P1，**A6 开工前必须裁定**）`secret ⇒ 必须 R5` 焊死了两个不同的轴

`schemas.ts` 强制 `data_classification === "secret"` 时 `risk === "R5"`。但 A6 第一批就是 identity 域：`identity.login` 带密码、PIN 快切带 PIN，都是 secret 入参，却不属于 ADR-05 #4 给 R5 的枚举（权限/密钥/备份恢复/审计删除/系统设置）。「入参含密钥」与「操作属 R5 类」是两件事。
**须二选一并写入 README**：① 放宽为 secret 不蕴含 R5（另以 `offline_mode: denied` + remove-only 脱敏约束兜底）；② 保留耦合，但明确 `secret` 的语义收窄为「凭据管理类命令」，login/PIN 走 `pii` + remove 脱敏。

> **已裁定（2026-07-20）：取 ①，见 [F1 裁定](2026-07-20-f1-secret-risk-ruling.md)。** Codex 于 `875ae3c` 已按此改毕并另加禁 `examples` 一条，本项确认无需再改。裁定另出两条补充：**F7 的修复时点由「打 tag 前」提前至「A6 落 identity 域之前」**（secret 的 remove-only 兜底完全依赖 `input_redaction` 生效，而 F7 使其可被静默跳过）；A6 评审单须增加漏标 `secret` 的逐命令核对项（契约层无法检测漏标）。

### F7（P1，**打 tag 前必修** → 裁定后提前为 **A6 开工前必修**）声明路径落在 `transform`/`pipe` 之下时，存在性与类型校验被静默跳过

`definitions.ts` 的 `requireInputPath` 只对 `missing` 报错、只在 `resolved` 时做类型检查；`resolveInputPath` 的第三种返回 `unresolved` 两边都不管，**静默接受**。该状态可达且受支持：`schema-graph.ts:160` 明确放行 pipe 输出侧的 transform。

**三种触发形态均已实测**（input 为 `z.strictObject({ t: z.strictObject({ x: z.string() }).transform(o => o) })`）：

```js
input_redaction: [{ path: "/t/bogus/deep", strategy: "mask" }]   // 路径根本不存在 → 接受
size_measures: { amount: { kind: "field",        path: "/t/x" } } // x 是 string 非 number → 接受
size_measures: { batch:  { kind: "array_length", path: "/t/x" } } // x 是 string 非 array  → 接受
```

对照组证明校验本该生效：同样声明打在无 transform 的 `/x` 上会被正确拒绝（"incompatible schema type"），`/nope` 也会被拒（"does not exist"）。

**关键在于本包内没有任何下游补检**：`limits.ts` 全文只做配置自洽性校验，**没有运行时 measure 求值器**。也就是说 `requireInputPath(..., z.ZodNumber)` 是 A1 层对「金额路径确实指向数字」的**唯一**静态保证，而它可被一个 transform 完全绕开。源码注释「transforms remain downstream checks」描述的是意图，当前实现是**静默放行且不留痕**，不是可控延后。

后果：`input_redaction` 路径写错则定义期无错、规则永不匹配，PII 直接进审计日志与 LLM 上下文；`size_measures` 指错则 C5 算不出规模，若当 0 处理则 R3 命令永不升 R4。`unresolved` 在测试中**一次未出现**，正对应 `input-schemas.ts` 69.38%/60% 的覆盖率洼地。

**修法**：定义期把 `unresolved` 一并当错误（至少对 `size_measures` 强制要求 `resolved`）。命令作者总能把被脱敏/被计量的字段移出 transform。

### F12（P1）合法的 `z.literal([...])` 无法注册，且抛裸 `Error`

`integrity-snapshot.ts:66` 对所有 `literal` 类型把 `value` 加入 accessor 白名单，`:175` 强制求值该 getter——而 Zod v4 多值字面量的 `value` getter 会主动抛错。实测 `defineCommand({ input: z.strictObject({ f: z.literal(["a","b"]) }) })`：clone ok → isSafeContractInput ok → validateSchemaMetadata ok → **`captureInputIntegrity` 抛 `Error`（非 `ZodError`）**。

两个问题：① 一个完全合法的 Zod v4 schema 无法注册，A6 写枚举型字段时会撞上；② 该错误逃逸了 design §8 的「所有构造校验失败统一抛 ZodError」契约——因为 `captureInputIntegrity` 的调用点在 `snapshotInput` 的 try/catch **之外**（这也让下方 D4 从「理论路径」变为**已证实可达**）。

### F2（P1）`examples` 没有契约承载

§6.5 与 ADR-05 #2 明写投影附「LLM 描述、**示例**、参数脱敏规则」三样。描述有（`description_llm`）、脱敏有（`input_redaction`/`result_redaction`），示例全仓为零。C4 只能自行编写示例——正是 ADR-05 #2「不存在第二套工具实现」要禁止的。加可选字段非 breaking，但**归属决定应在 A1 作出**。

### F8（P1）README 承诺 `max_result_rows` 可被组织收紧，但**代码里没有任何实现**

README 与 design 都写了「组织/预设只能进一步收紧 `max_result_rows`」。但 `max_result_rows` 在 `src/` 里只出现于 schema 定义与 PII 上限判定，**没有任何覆盖校验器**——对比 `hard_limits`/`risk_escalation` 有 `validateStricterLimitOverride()` 兜底：同一句承诺，一半有代码一半没有。C5 若照 README 实现会发现无 API 可调。
**须二选一**：补一个与 `validateStricterLimitOverride` 同形的查询侧收紧校验器，或删掉该承诺并注明「查询行数上限的 per-org 收紧不在 v0.1.0 范围」。

### F3（P1）`invariants` / `sideEffects` 绑定名无解析保证

文档称「C1 解析到不变量检查器，A1 不执行绑定」，但未规定**解析不到时的行为**。同一个包里 `size_measures.path` 有存在性与类型校验，绑定名却只是字符串——打错一个字母即静默变成「该命令无不变量」，而校验链把不变量当一道关。A1 确实无从校验（绑定在别处），但**契约语义应规定 C1 遇未解析绑定 fail-closed**，写入 README 作为对 C1 的要求。

## 三、未披露的输入侧收窄（**A6 开工前必须补进 README**）

方向都正确，但文档未提示；A6 作者会在这三处撞墙且看不出原因：

1. **`z.custom()` 与 `z.instanceof()` 一律被拒**。README 只说拒绝 `z.any()`/`z.unknown()`/伪造解析器——而 `z.custom()` 是 Zod 一等 API，不是伪造。A6 若写 `z.instanceof(Date)` 会直接构造失败（须改用 `z.date()`）。
2. **递归/自引用输入 schema 不可能**：全部 `z.lazy()` 被拒（含 `z.lazy(() => z.strictObject({...}))`）。A6 若需树形入参，契约层无路可走。
3. **`risk_escalation` 仅基础 R3 可声明**（`hard_limits` 则不限风险等级）。A1 自己的 README 有写，但 **ADR-09 无此限制**——即实现严于其治理 ADR。我判定该收窄**正确**（§6.5 与 ADR-05 #4 都只定义 R3→R4），已在 [ADR-09 修订 2](../../../../adr/2026-07-20-adr-09-command-metadata-precision.md) 中补记，使二者对齐。

## 四、记录项（不阻塞冻结，需写入 README 或 A6 须知）

| # | 项 | 说明 |
|---|---|---|
| F4 | R2 查询的脱敏与限量绑在 `pii` 而非 `risk=R2` | §6.5 的 R2 行要求「权限+脱敏+限量」。`max_result_rows` 对所有查询强制（限量字面满足），但 1000 行上限与强制脱敏只在 `pii` 时生效，R2+internal 两者皆免。**实测确认**：非 PII 查询声明 1,000,000 行放行。可辩护，须记为明确的语义决定 |
| F9 | §3.1 / §3.2 无书面回应（「沉默改正」） | README 与 PR 的六条答复实际映射到 §3.3、§3.4(×2)、§3.5、§3.6 与 version/major，**§3.1 与 §3.2 无独立回应**。git 历史显示原设计稿（`bd1b788`）持 `offline_allowed: boolean` 与「升级阈值下沉」两个立场——正是 ADR-09「否决的备选」驳回的两条；`729faaf` 改为合规形态但全文未承认立场被推翻。要求：README 补两段，记录该形状为何不是布尔量。**理由不是流程仪式**——若不留档，后人会把它「简化」回布尔，ADR-04 的防双花保证再次蒸发 |
| F10 | PII 1000 行上限只有结论没有推导 | 声明为「fail-closed 安全线」，但无依据。请补一句推导或明确标注为待调参的占位值 |
| F11 | `size_measures` 可不带任何阈值单独声明 | 实测放行，成为惰性声明。是否有意？请明确——若无意，补约束；若有意（为 C5 预留观测），写进 README |
| F5 | `validateStricterLimitOverride` 拒绝 org 引入出厂线没有的阈值维度 | 比 ADR-09 决策 3 字面更严；技术上 fail-closed 合理（无 `size_measures` 无法求值），但有产品后果：门店想加限额必须先有出厂线 |
| F6 | 查询侧 `offline_mode` 硬编码 `denied` | §11「查历史 Edge 缓存窗口只读」在契约层无表达。ADR-09 决策 4 已预留此选择，属有意识延后（日后加可选字段非 breaking），须写下来免得被当成「离线读契约上不可能」 |
| D1 | 嵌套裸伪造解析器无专门检查 | README/design 称「拒绝任意层级的伪造解析器」，但只有根级与 mini/core 变体有实现；shape 内的 `{parse(){}}` 裸对象不触发任何拒绝规则，只在下游以**非 ZodError** 形式炸开。非安全漏洞（假解析器不会真被当校验器用），属声明与实现不符 |
| D2 | 「**无法静态展开的** `z.lazy()`」限定词在代码里不存在 | `schema-graph.ts:155` 无条件拒绝全部 lazy。文档语义比实现宽，应改文档 |
| D3 | 「不修改调用者对象」与实现相抵 | `schema-clone.ts` 读调用方 `def.shape` 的自替换记忆化 getter，会把调用方 def 改写成数据属性。canonical 隔离仍成立，但该措辞字面不成立 |
| D4 | 裸错误逃逸 design §8 的「统一 ZodError」——**已证实可达** | `captureInputIntegrity` 的调用点在 `snapshotInput` 的 try/catch 之外。原判「实践中大概率不可达」被推翻：F12 的 `z.literal([...])` 即可触发 |
| F13 | 错误类型随嵌套深度变化 | 同 D4 根因。实测：深度 ≤900 正常注册；1500 抛**裸 `RangeError`**；3000 抛 `ZodError`（已归一化）。递归遍历无深度上限但**无静默截断**（要么走完要么抛），故安全性无碍，属错误契约不一致 |
| F14 | `protectResult` 让原始函数逃出膜 | `input-membrane.ts:96` 对非 object 原样返回，故 `typeof === "function"` 直接透出：`definition.input._zod.deferred.at(0)` 返回**原始闭包**（而 `[0]` 返回 guarded 包装器）。实测**不可利用**——它是读/调用 oracle 而非写入原语，给泄漏函数加属性后 `isContractDefinition` 仍为 true 且校验行为不变，承载容器仍拦截所有变更。记录为一致性缺口 |
| D5 | 非法 Date 阈值的检查实现在**克隆器**而非校验器 | README 把它与 `default`/`prefault`/`catch` 并列写在「输入图拒绝」下，读者会预期它在 `isSafeContractInput` 中。检查本身真实有效且有测试，属文档定位误导后续维护者 |

## 五、超出要求的部分（据实记录）

- **R5 不可投影做了三重**：类型层 `Exclude<Risk,"R5">` + 运行时守卫 + 断言（`definitions.test.ts:266`）。评审单只要求二选一。
- **`validateCommandInputPaths` 校验声明路径在真实 input schema 中存在且类型兼容**——我未要求，但这是把「阈值进契约」从可声明变成可执行的关键一层（F7 是它的边界情况，不减损该设计）。
- **Date 防护是双层纵深**：膜层与完整性快照，且都用模块加载时捕获的 `Date.prototype.getTime`，原型链篡改亦无法绕过——强于其自身声明。
- **代码比文档更严的收窄有八处**：lazy 全拒、`z.custom()` 仅限 checks、`transform` 仅限 pipe 输出、metadata 必须纯 JSON、图中成环即拒、除 object `shape` 外任何 accessor 即拒、非白名单可变类型即拒、克隆的 RegExp 钉上原始 `exec`/`test`。**方向正确**，但文档需补齐，否则 A6 作者会撞上未记录的墙。

## 六、放行与后续

1. **A2 可即刻开工**——[A2 评审单](a2-envelope-and-errors.md)已提前发出，含两处 P0 形状陷阱预登记（信封租户自报、`args`/`confirm_ref` 并存绕过 canonical 冻结）。
2. **`contracts@v0.1.0` 的 tag 待 A1–A7 全组通过后打**，非本组通过即打。F1 的裁定与 F7 的修复应在 tag 前落地。
3. 环境须知（非本 PR 缺陷）：全新工作树跑 `workspace:check` 需先解决 pnpm 构建审批（`ERR_PNPM_IGNORED_BUILDS`，且 pnpm 会改写 `pnpm-workspace.yaml` 致 `prettier --check` 失败）。建议全队统一处理，否则每个新 worktree 都会踩。
