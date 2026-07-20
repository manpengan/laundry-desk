# ADR-09: 命令元数据字段精确化（离线档位与风险升级阈值）

- 日期：2026-07-20　状态：**Proposed**（起草：Claude；待 manpengan 签署）　父文档：[总 RFC](2026-07-19-v2-productization-and-ai.md)
- 详设：架构 §6.5（命令定义）、§11（离线矩阵）；上游：ADR-04 第 7 条、ADR-05 第 4/12 条
- 触发：A1 契约落地评审准备（Claude，2026-07-20）——架构 §6.5 的两处字段形态与已 Accepted 的 ADR-04/05 语义不自洽，冻结前必须定形状

> **本 ADR 不回改任何已 Accepted 正文**。ADR-04/05 的语义是对的，问题在架构 §6.5 的元数据伪码是 draft3 补齐时写下的**有损简写**，早于 ADR-04 终审的 Primary lease 工作。此处以新增 ADR 补正简写，属"后续变更走新增 ADR"的既定流程。

## 决策

1. **`offline_allowed: bool` 改为三值 `offline_mode`**：
   - `denied` —— 离线一律禁止（退款、储值/会员卡支付、办卡充值、设置修改、AI；ADR-04 第 3 条）；
   - `grant` —— 持有效 offline grant 的**任何配对终端**可离线执行（开新单、打印）；
   - `primary_lease` —— **仅持有效 Primary lease 的终端**可离线执行（取衣、收款）。
   命令总线与 Edge 判定离线可执行性时**只读此字段**，不得另立判据。
2. **`max_batch` 一拆为三**：规模**怎么算**、超了**拒绝**、超了**升级**是三件事，各占一个字段。

   ```ts
   size_measures?: {                                      // 怎么算（修订 1 新增）
     batch?:  { kind: 'array_length'; path: string }
            | { kind: 'numeric_sum';  path: string; field: string };
     amount?: { kind: 'field';        path: string }
            | { kind: 'numeric_sum';  path: string; field: string };
   };
   hard_limits?:     { max_batch?: number; max_amount_cents?: number };  // 超即拒
   risk_escalation?: { max_batch?: number; max_amount_cents?: number };  // 超即 R3→R4
   ```

   `path` 沿用 `result_redaction` 已采用的 RFC 6901 JSON Pointer，不另立寻址语法。`max_amount_cents` 承载"单笔调整 >100 元"一类金额阈值（原四字段仅有数量维，无处安放）。

   **良构约束（构造时校验，违反即 `ZodError`）**：
   - 任一维出现阈值（`hard_limits` 或 `risk_escalation` 的对应键），该维的 `size_measures` 必填——否则阈值无从求值；
   - 同维并存时须 `risk_escalation.max_* ≤ hard_limits.max_*`——否则升级阈值高于硬上限，超限先被拒，R4 step-up 通道（ADR-05 第 11 条）成为死代码。
   - **`risk_escalation` 仅基础风险为 R3 的命令可声明**（修订 2 补记）；`hard_limits` 不限风险等级。依据：§6.5 与 ADR-05 第 4 条定义的升级路径只有 `R3 → R4` 一条，R0–R2 无升级语义，R4/R5 已在或高于目标等级。
3. **出厂线与 per-org 覆盖分离**：注册表内的阈值是**出厂线**；per-org 覆盖值不进注册表（属 settings 域）。契约包导出"只可调严"校验器（`override.max_batch ≤ factory.max_batch` 且 `override.max_amount_cents ≤ factory.max_amount_cents`），由 Policy Engine（C5）在读取覆盖值时强制，实现 §6.5"阈值只能调严不能调松出厂线"。
4. **查询侧离线语义**随 A1 的命令/查询判别式决定（评审单 §3.3）：查询若共用 `offline_mode`，须补 `cache_read` 档以表达 §11"Edge 缓存窗口只读"；若命令与查询分立 schema，则查询侧自有字段，命令侧枚举保持本 ADR 决策 1 的三值。

## 理由

- 布尔量无法区分 `grant` 与 `primary_lease`：而"取衣/收款仅 Primary lease"正是 ADR-04 防离线双花的业务规则层杜绝手段（两台离线终端交付同一件衣物，冲突队列**无法追回实物**）。契约层丢掉这一维，等于把 ADR-04 终审 P0 的成果在实现入口处作废。
- "批量上限"与"升级阈值"是两种可观测行为（拒绝 vs 升级），伪码把二者写在同一行注释里，实现方必须猜；猜错的方向是"超限即拒"，会让 R4 step-up 通道（ADR-05 第 11 条）永远走不到。**此预判已被实证**：Codex 未见本 ADR 时独立完成的 A1 设计稿正是把 `max_batch` 定义为"超出直接拒绝"的硬上限，升级阈值下沉实现层。
- 金额阈值在 §6.5 与 ADR-05 第 4 条都被明文要求，却没有承载字段——不补则"单笔调整 >100 元"只能硬编码进业务代码，脱离契约与审计。
- **规模求值方式必须与阈值同处契约**（采纳 Codex 于 A1 设计评审提出的缺口）：批量规模因命令而异——数组长度、数量合计、金额与件数联合——本 ADR 初稿只给了阈值 `max_batch: number`，却没说这个数从入参怎么算出来，C5 只能逐命令硬编码求值逻辑，阈值随之退回不可审计。补 `size_measures` 后，"阈值进契约"才真正可执行而非仅可声明。

## 否决的备选

- **保留 `bool`，把 lease 要求下沉到 Policy Engine 硬编码**：判据散落在实现里，Edge 侧无契约可依，且与"注册表是唯一权威"冲突。
- **用 `offline_allowed: bool` + 另一个 `requires_primary_lease: bool`**：两个布尔可表达四种组合，其中"不允许离线但需要 lease"是无意义状态；三值枚举无非法态。
- **等 M2 再补**：M1 的 Edge v0 与命令总线都要读这个字段，M2 再改即契约 breaking，按 ADR-08 需进 major。
- **`offline_allowed: bool` 仅表"进入离线队列的候选资格"，档位判定归 A4/C1/C5 与 Edge 共同强制**（Codex A1 设计稿 §4 立场）：分层本身成立，但"取衣/收款仅 Primary lease"是**业务规则**，若契约只表候选资格，该规则必然逐命令硬编码进 C5 或 Edge，Edge 侧无契约可依。三值枚举并不侵犯该分层——声明档位 ≠ 授予权限，**是否真持有**有效 lease 仍由运行时校验。其担心的"字段被误读为授权"以命名与 TSDoc 解决，不必退回布尔。
- **`max_batch` 单字段即硬上限，升级阈值整体下沉 B4/C5 命令策略**（Codex A1 设计稿 §3 立场）：硬上限该进契约这点成立，已采纳为 `hard_limits`；但升级阈值一并下沉会使 ADR-05 第 4 条的"单笔调整 >100 元"失去契约承载，决策 3 的 per-org"只可调严"校验器无处施力，且阈值散入实现后不可审计。故拆三字段而非二选一。

## 后果

- A1 按本 ADR 落地（评审单 [a1-command-registry.md](../superpowers/plans/tasks/m1-acceptance/a1-command-registry.md) §3.1/§3.2 为通过标准）。
- C1 命令总线、C5 Policy Engine、D 包 Edge 三处的离线判定统一读 `offline_mode`；C5 另实现决策 3 的"只可调严"校验。
- C5 判定规模类阈值的顺序固定为：按 `size_measures` 求值 → 先判 `hard_limits`（超即拒）→ 再判 `risk_escalation`（超即升 R4）。**两步不可颠倒**，否则超硬上限的请求会先被升级成待审批项，把本该直接拒绝的输入送进审批队列。
- A6 首批命令定义时，identity/platform 域命令逐条标注 `offline_mode`（预期多为 `denied`：设置修改属 ADR-04 第 3 条禁离线项）。
- 若 manpengan 裁定不同形状，改动面限于 `packages/contracts` 内字段定义与其消费点，冻结前调整成本低。

## 签署

_待 manpengan 签署转 Accepted。签署前 Codex 按本 ADR 落地——理由：三值枚举是与已 Accepted 的 ADR-04 第 7 条唯一自洽的形状，等待签署会阻塞全队发令枪；若裁定有变，调整成本如上。_

## 修订记录

- **修订 1（2026-07-20）**：决策 2 由「`max_batch` 拆为 `risk_escalation` 二选一」改为 `size_measures` / `hard_limits` / `risk_escalation` 三字段并存，补两条良构约束（阈值蕴含求值声明必填；升级阈值不得高于硬上限）。
  触发：Codex 在未见本 ADR 的情况下独立完成 A1 设计稿（`packages/contracts/docs/a1-contract-registry-design.md`），其 §3 指出初稿未定义批量规模的求值方式——该缺口成立，予以采纳并致谢；其"升级阈值下沉实现层"的主张不予采纳，理由见「否决的备选」。
  本 ADR 仍为 Proposed，修订不改变签署状态。
- **修订 2（2026-07-20）**：决策 2 补第三条良构约束——`risk_escalation` 仅 R3 可声明。
  触发：A1 冻结评审发现实现已作此收窄（`schemas.ts`）且 A1 自身文档有载，但**本 ADR 无此限制**——实现严于其治理 ADR 是隐患（后人依 ADR 放宽即静默削弱）。经比对 §6.5 与 ADR-05 第 4 条，该收窄忠实于 spec（升级路径只有 R3→R4 一条），故补记入 ADR 使二者对齐，而非要求实现放宽。
  本 ADR 仍为 Proposed，修订不改变签署状态。
