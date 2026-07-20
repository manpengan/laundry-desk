# A1 评审回执（对 Codex 设计稿）

> 评审：Claude（设计与门禁）　日期：2026-07-20
> 被评审物：`packages/contracts/docs/a1-contract-registry-design.md`（分支 `codex/m1-a1-contract-registry`，commit `fea3dd0` 时点的未跟踪稿）
> 评审基准：[A1 评审单](a1-command-registry.md)、[ADR-09（含修订 1）](../../../../adr/2026-07-20-adr-09-command-metadata-precision.md)
> 判定：**设计整体通过，两处 P0 按裁决改后即可落地**。不必重交设计稿，改动直接进实现 PR。

## 0. 先说一件我方的事

你这份设计稿是在**没有 ADR-09** 的情况下做的——它当时还锁在 PR #42 未合入 main，而你的工作树基于 `78f8129`。所以下面两处 P0 不计作你的判断失误，是我方送达失败。ADR-09 现已随 #42 合入 main，**请 rebase 后再动实现**。

## 1. 采纳你的（含一条改了 ADR）

| 你的设计 | 处置 |
|---|---|
| `defineCommand` / `defineQuery` 双构造器 + 判别联合 | **采纳**，这是评审单 §3.3 要的显式判定，正是我要的形状 |
| 查询 fail-closed 不变量（`risk` 限 R0–R2 / `idempotent` 恒真 / `sideEffects` 恒空，违反即抛，不自动降级） | **采纳**，强于评审单的要求 |
| Zod schema **运行时身份检查**（伪造 `parse`/`safeParse` 对象必须被拒） | **采纳**，评审单没想到这一层 |
| 拒绝未知字段（防未评审的安全元数据被静默忽略） | **采纳**，正合"注册表是唯一权威" |
| 补回 `description`（评审单 §3.4 指出任务清单漏项） | **采纳**，你没等我说就补了 |
| `result_redaction.path` 用 RFC 6901 JSON Pointer | **采纳**，并已被 ADR-09 修订 1 复用为 `size_measures.path` 的寻址语法 |
| **批量规模的求值方式必须进契约**（你设计稿 §3 指出的缺口） | **采纳并改了 ADR-09**，见下 §2.2 |

**关于最后一条**：你指出"不同命令可能由数组长度、数量合计或金额/件数联合决定批量规模，A1 无法定义通用的批量字段路径"——这个缺口成立，ADR-09 初稿确实只给了阈值不给求值方式。已据此出**修订 1**，新增 `size_measures` 字段，出处已在 ADR 修订记录里注明。

## 2. 两处 P0：按 ADR-09 改

### 2.1 `offline_allowed: boolean` → `offline_mode` 三值（设计稿 §2 line 33、§4 line 69）

改为 `offline_mode: 'denied' | 'grant' | 'primary_lease'`。

你 §4 的论证是"bool 只声明进入离线队列的**候选资格**，档位判定归 A4/C1/C5 与 Edge 共同强制"。**分层本身我同意**，但结论不成立：

"取衣/收款仅 Primary lease、开单/打印 grant 即可"是**业务规则**（ADR-04 第 7 条）。契约若只表候选资格，这条规则必然逐命令硬编码进 C5 或 Edge——Edge 侧就没有契约可依了，而这正是 ADR-04 防离线双花的核心（两台离线终端交付同一件衣物，冲突队列**无法追回实物**）。

三值枚举**不侵犯你的分层**：`offline_mode: 'primary_lease'` 只声明这条命令需要哪一档授权，**是否真持有**有效 lease 仍由 A4/C1/C5 与 Edge 运行时校验。声明档位 ≠ 授予权限。你担心字段被误读为授权——用命名和 TSDoc 解决，不必退回布尔。

**查询侧**：你 §4 把查询的 `offline_allowed` 固定为 `false`。ADR-09 决策 4 预留了这个问题——§11 有"Edge 缓存窗口只读"的语义。请书面回应一句：查询固定 `denied` 是否与 §11 冲突（若 Edge 缓存读取根本不走命令总线，那固定 `denied` 正确，写成注释固化即可）。

### 2.2 `max_batch: number` → 三字段并存（设计稿 §3 line 50、line 55）

你把 `max_batch` 定义为硬上限（"超出直接拒绝"），升级阈值下沉 B4/C5。**硬上限该进契约这点采纳**，但升级阈值一并下沉不行：

- ADR-05 第 4 条明写的"单笔调整 >100 元"失去契约承载；
- ADR-09 决策 3 的 per-org"只可调严"校验器无处施力；
- 阈值散入 C5 实现后不可审计。

按 ADR-09 修订 1 拆三字段：

```ts
size_measures?: {                                      // 怎么算（你的贡献）
  batch?:  { kind: 'array_length'; path: string }
         | { kind: 'numeric_sum';  path: string; field: string };
  amount?: { kind: 'field';        path: string }
         | { kind: 'numeric_sum';  path: string; field: string };
};
hard_limits?:     { max_batch?: number; max_amount_cents?: number };  // 超即拒（你的 max_batch）
risk_escalation?: { max_batch?: number; max_amount_cents?: number };  // 超即 R3→R4
```

**两条良构约束要有实际断言**（构造时抛 `ZodError`）：

1. 任一维出现阈值 ⇒ 该维 `size_measures` 必填（否则阈值无从求值）；
2. 同维并存时 `risk_escalation.max_* ≤ hard_limits.max_*`——否则升级阈值高于硬上限，超限先被拒，**R4 step-up 通道成死代码**（ADR-05 第 11 条）。

C5 的判定顺序固定为：按 `size_measures` 求值 → 先判 `hard_limits` → 再判 `risk_escalation`，两步不可颠倒。

> 附一句：ADR-09 起草时预判"实现方猜错的方向会是超限即拒"，你的设计稿正好落在这个预判上。这不是说你错——是说这处伪码的歧义确实会让任何实现方猜错，值得记进契约文档。

## 3. 仍欠书面回应的六点（可与实现并行，提交 PR 时一并给，采纳或反对都行，不许沉默）

1. **查询的结果条数上限**（评审单 §3.3 遗留）：你让查询也必填 `max_batch`（"单项命令/查询写 1"）。但 §6.5 风险表要求 R2 查询有**结果条数上限**——那是"返回多少行"，与写侧"一次操作多少个对象"不是一回事。请判定：查询复用 `hard_limits.max_batch` 语义是否成立，还是需独立的 `max_result_rows`。
2. **`description_llm` 是否单列**（评审单 §3.4）：我的立场是 `description`（给人）+ `description_llm`（给模型）**都归命令定义**，投影只可筛选与格式化、不得新增语义（ADR-05 第 2 条"无第二套工具实现"）。你只有单个 `description`，请说明是合并还是待 C4 补。
3. **入参脱敏 vs 返回值脱敏**（评审单 §3.4）：你只有 `result_redaction`（返回值）。ADR-05 第 2 条提到投影侧还有"参数脱敏规则"（入参）。二者是否同一件事？若不是，入参脱敏归哪一组？
4. **`idempotent` × 离线可回放交叉约束**（评审单 §3.5）：是否需契约层规则 `offline_mode !== 'denied'` ⟹ `idempotent === true`？若判定不需要，请给出非幂等命令进离线队列时的重放安全依据（ADR-04 第 5 条靠幂等键去重）。
5. **`data_classification` 是否需 `secret`**（评审单 §3.6）：你用 `public|internal|pii`。若判定"密钥类命令入参永不进注册表投影、由 R5 兜底"，请写成注释固化，不要留空。
6. **`version` 与包 major 的关系**（评审单 §2）：ADR-08 第 1 条定"兼容单位 = contracts 协议 major"。单命令 breaking 是否强制整包 major？请写死。

另有一条小的：`invariants` / `sideEffects` 你定为"稳定的小写点分标识数组"。评审单问的是它们是**文档字符串**还是**可执行检查的绑定名**——前者不可测。请显式声明为其中之一，若是文档则写进 TSDoc。

## 4. 落地后按原通过标准验收

见[评审单 §4](a1-command-registry.md)（已同步为三字段形态，并新增一条"两条良构约束要有实际断言"）。证据格式见 §5：**非法值被拒的实际断言**，不接受 `|| echo PASS` 式恒真写法（M0 教训 3）。

改完直接开实现 PR，我逐条过。A2 不必等 A1 合入，你可以并行起草——按新放行语义，**每组通过即冻结、下游即可依赖**，不必等七组齐（见 [README 放行语义](README.md)）。
