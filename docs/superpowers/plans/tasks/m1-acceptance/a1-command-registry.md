# A1 评审单：命令/查询注册表 schema

> 主责：**Codex**（Zod 落地）　评审：Claude（语义与冻结）　落点：`packages/contracts`
> 依据：架构 §6.5（命令定义/信封/校验链/R0–R5）、§9.4–9.6、§11（离线矩阵）、ADR-05（全条款）、ADR-04 第 7 条、ADR-08 第 1 条
> 公共规则见 [README](README.md)。**本单在 Codex 动手前发出**——§3 三条争议点先定形状，避免落地后返工。

## 1. 目标

把 §6.5 的命令/查询注册表从"设计伪码"变成可被 C1 校验链、C4 Tool Registry 投影、C5 Policy Engine 三处同时消费的**唯一权威类型**。A1 是 A2–A7 的地基，也是全队发令枪的枪机——形状错一处，C1/C4/C5 三处一起返工。

## 2. 评审基准：字段逐条（对照架构 §6.5 原文）

| 字段 | spec 原文形态 | 评审要点 |
|---|---|---|
| `name` | — | 命名空间约定（`域.动作`）；M1 首批为 identity/platform 两域（A6 用） |
| `version` | semver 进信封 | 与"兼容单位 = contracts 协议 major"（ADR-08 第 1 条）的关系必须写死：单命令 breaking ⇒ 是否强制包 major |
| `input` | `ZodSchema` | 必须是 A7 `zod-to-openapi` 可生成的形态 |
| `risk` | `R0–R5` | 枚举齐全；R5 的**不可投影**性见 §3.4 |
| `description` | `(给人+给LLM)` | **A1 任务清单里漏了此字段**，见 §3.4 |
| `invariants[]` | — | 判定：文档字符串还是可执行检查的绑定名？前者不可测，须显式声明为文档 |
| `idempotent` | `bool` | 与信封 `idempotency_key`、离线回放去重的关系见 §3.5 |
| `sideEffects[]` | — | 同 `invariants`：枚举还是自由文本 |
| `offline_allowed` | `bool` | **形状不足，见 §3.1（P0）** |
| `data_classification` | `public\|internal\|pii` | 是否需第四值 `secret`（token/密钥）见 §3.6 |
| `max_batch?` | `number`「批量上限（触发 R3→R4 升级阈值）」 | **上限与阈值语义冲突 + 缺金额阈值，见 §3.2（P0）** |
| `result_redaction?` | 脱敏规则 | 与投影侧"参数脱敏规则"是否同一件事，见 §3.4 |

## 3. 预登记争议点（Codex 提交时必须逐条书面回应）

以下均为**架构 spec 自身的歧义**，非 Codex 实现问题。§3.1/§3.2 已由 [ADR-09](../../../../adr/2026-07-20-adr-09-command-metadata-precision.md) 定形状（Proposed，待 manpengan 签署）——**按 ADR-09 落地，勿按 §6.5 字面**。

### 3.1（P0）`offline_allowed: bool` 表达不了三档离线授权

§6.5 写 `bool` 且注释指向 §11，但 §11 与 ADR-04 第 7 条定义的是**三档**：`denied`（退款/储值/办卡/设置/AI 一律禁）/ `grant`（开单、打印：任何持有效 offline grant 的配对终端）/ `primary_lease`（**取衣、收款：仅持有效 Primary lease 的终端**）。布尔量一落地，"取衣/收款需 Primary lease"这条**防离线双花的核心**在契约层直接蒸发，C1 与 Edge 无从据以判定。→ ADR-09 决策 1：改三值枚举 `offline_mode`。

### 3.2（P0）`max_batch` 语义冲突且缺金额阈值

同一行注释里"批量上限"（cap，超了拒绝）与"触发 R3→R4 升级阈值"（escalate，超了升级）是**两种不同行为**，实现方必须二选一。且 §6.5 与 ADR-05 第 4 条都要求"数量**/金额**阈值触发升级"（例："单笔调整 >100 元"），而元数据四字段里**没有金额阈值字段**。→ ADR-09 决策 2：拆 `risk_escalation: { max_batch?, max_amount_cents? }`，语义定为升级阈值；硬上限如需要另立字段。附带约束："阈值 per-org 可配但只能调严"（§6.5）必须在契约层可表达、可测。

### 3.3 命令与查询：一张表还是两张

A1 名为"命令/查询注册表"。查询的 `idempotent` 恒真、`sideEffects` 恒空、`invariants` 不适用；而 R2 要求"权限校验 + 脱敏 + **数量上限**"（§6.5 风险表）——查询需要的是**结果条数上限**，与写侧的 `max_batch` 不是一回事。请给出显式判定：单 schema + `kind: command|query` 判别式（各自必填字段用 discriminated union 收紧），还是两个 schema。**不接受**一个所有字段可选的松散并集。

### 3.4 `description` 归属：命令定义还是投影时附加

§6.5 schema 行写 `description(给人+给LLM)` 在命令上；同节散文与 ADR-05 第 2 条却说"**投影时附加** LLM 用描述、示例、参数脱敏规则"。且 A1 任务清单（计划 §2.1 / 任务书）**整条漏了 `description`**——照清单实现，C4 投影将无处取描述。同理"参数脱敏规则"（投影侧）与 `result_redaction`（命令侧）是否同一件事需说清：**入参脱敏与返回值脱敏不是一回事**。
**我的评审立场**（Codex 如反对请在提交时说明理由）：`description` + `description_llm` 归**命令定义**——ADR-05 第 2 条"无第二套工具实现"的要义就是单一真源；投影只可**筛选与格式化**，不得新增语义。

### 3.5 `idempotent` 与离线可回放性的交叉约束

ADR-04 第 5 条的恢复流程靠"幂等键去重"。请判定是否需要契约层交叉规则：`offline_mode !== 'denied'` ⟹ `idempotent === true`。若判定不需要，请说明非幂等命令进离线队列时的重放安全依据。

### 3.6 `data_classification` 是否需要 `secret`

§8 要求审计与日志"不落 token、密钥、完整手机号"。`pii` 覆盖手机号；token/密钥若可能出现在命令入参（如 BYOK 保存 key，R5），是否需第四值？若判定"密钥类命令入参永不进注册表投影且由 R5 兜底"，请写成注释固化，不要留空。

## 4. 通过标准（逐条判定，全绿才进 A2）

- [ ] 十二个字段全部落地（含 §3.4 的 `description`）；每个字段有 TSDoc 注明 spec/ADR 出处（可追溯到条款号）。
- [ ] §3.1/§3.2 按 ADR-09 落地：`offline_mode` 三值枚举、`risk_escalation` 拆分且语义为升级阈值。
- [ ] §3.3–§3.6 四点**逐条书面回应**（PR 描述或 `packages/contracts/README.md`）——采纳或反对均可，但不得沉默。
- [ ] `risk` 与 R5 不可投影：给出**机制**而非约定——类型层排除或契约测试断言"投影结果不含 R5"，二选一。
- [ ] Zod schema 自身可测：至少覆盖每字段的非法值拒绝（枚举外值、负数阈值、缺必填）。
- [ ] 类型可被三方消费：`packages/contracts` typecheck 零错，且给出 C1/C4/C5 各取一例的消费样例（编译通过即可，无需运行时）。
- [ ] `pnpm -w typecheck` / `lint` 零错零警；文件 ≤400 行、函数 ≤50 行、嵌套 ≤4。
- [ ] 依赖若有增删，`package-lock.json` 与 `pnpm-lock.yaml` **同时**更新（M0 教训 4，#38 已踩）。
- [ ] 提交前已 `git fetch origin && git rebase origin/main`（M0 教训 2）。

## 5. 证据格式

- PR 描述：§3 六点逐条回应 + §4 清单逐项自查（勾选并附一句话证据指引）。
- `packages/contracts/README.md`：注册表 schema 的语义说明（字段 → spec 条款映射表），后续 A2–A7 续写同一文件。
- 测试：`packages/contracts` 内 schema 单测输出（非法值被拒的实际断言，**不接受 `|| echo PASS` 式恒真断言**——M0 教训 3）。
- typecheck/lint 实跑输出粘贴（M0 教训 1：无实测证据不写"通过"）。

## 6. 不通过 / 需改设计

字段缺失或 §3.1/§3.2 未按 ADR-09 落地 = 不通过，退回重提。§3.3–§3.6 若 Codex 的判定与我的评审立场相左且理由成立 → 我起草 ADR 补充澄清（不回改 ADR-05 正文），**不因分歧阻塞 A2 开工**。
