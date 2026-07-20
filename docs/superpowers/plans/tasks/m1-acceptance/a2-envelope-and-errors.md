# A2 评审单：统一信封 + 错误码表

> 主责：**Codex**（Zod 落地）　评审：Claude（语义与冻结）　落点：`packages/contracts`
> 依据：架构 §6.5（命令信封/校验链）、硬约束 3、§4 与 ADR-02 #10（租户不可自报）、ADR-05 #10（canonical args 冻结）、§8（审计不落 PII）
> 公共规则见 [README](README.md)。**本单在 Codex 动手前发出**——§3 两处形状陷阱与 A1 的 `offline_allowed` 同类：契约形状一旦松，安全保证在入口处即被绕过。

## 1. 目标与范围澄清

A2 的名字只写了响应信封，但 §6.5 定义了**两个**信封，且**命令信封在 A1 注册表里没有位置**（A1 是命令的静态定义，信封是每次执行的动态载荷）。若 A2 不收，它会掉在 A1 与 A6 之间的缝里。

**本单裁定：A2 同时冻结两者**——
1. **命令信封**（请求侧）：`{command, version, args, actor{staff_id, device_id, via}, tenant{org_id, store_id}, idempotency_key, dry_run, confirm_ref?}`
2. **响应信封**（返回侧）：`{ok, data} | {ok, error}` + 错误码表

## 2. 预登记形状陷阱（Codex 提交时必须逐条回应）

### 2.1（P0）信封含 `tenant`/`actor`，但两者**不得来自客户端**

§6.5 的信封字段里有 `tenant{org_id, store_id}` 和 `actor{staff_id, device_id}`；而 §4 与 ADR-02 #10 明令"租户上下文**只来自服务端认证会话注入**，浏览器/LLM/Edge 自报一律忽略"。二者并存的唯一自洽解释是：**命令信封是服务端组装的内部结构，不是客户端可发的线路格式**。

若 A2 把它定义成一个 Zod schema 就完事，C8 中间件、AI Runtime、Edge 回放三处都可能直接拿客户端载荷去 parse 成信封——自报的 org/store 就此生效，ADR-02 的第一道防线在入口处失效。

**要求**：契约层区分两个类型——**线路载荷**（客户端/LLM/Edge 可发：`command`、`version`、`args` 或 `confirm_ref`、`idempotency_key`、`dry_run`）与**命令信封**（服务端组装，多出 `actor`/`tenant`）。且**类型上不可由线路载荷直接构造出信封**（如信封带 brand、只由注入函数产出，参照 A1 `ContractDefinition` 的 brand + WeakMap 手法）。请给出机制而非命名约定。

### 2.2（P0）`args` 与 `confirm_ref` 并存会绕过 canonical args 冻结

ADR-05 #10：确认卡创建时参数落库为**唯一权威副本**，"店员确认**只提交 nonce，客户端不回传参数**；执行时从服务端读取冻结参数"。

若信封把 `args` 和 `confirm_ref?` 定义成两个互不相干的可选字段，客户端可同时提交二者；C1 若读了 `args`，WYSIWYS（所见即所签）当场失效——这正是 ADR-05 理由段点名的"确认后换参数"绕过。

**要求**：二者**互斥**，用判别式联合表达：`{mode:'direct', args}` | `{mode:'confirm', confirm_ref}`（命名自定）。`confirm_ref` 存在时 `args` 在类型上不可提供、运行时被拒。附断言：构造同时含二者的载荷 → 解析失败。

### 2.3 `actor.via` 四值与审计归属

`via: ui|ai|automation|edge_replay` 必须穷举且与 §6.5 一致（审计归属与 Policy 判定都读它）。请确认：`via` 是否参与 Policy 判定的类型收窄（ADR-05 #1「按 via+risk 决定」）；`edge_replay` 是否需携带 A4 的 `lease_id + primary_epoch + per_lease_seq`（ADR-04 #7 要求离线高危命令绑定三元组）——若需要，是 A2 收还是 A4 收，请明确，勿两边都不收。

### 2.4 错误码表的三项硬要求

1. **不泄漏存在性**：跨租户访问的错误码与"资源不存在"**不可区分**（T5 跨租户门禁 L1 断言此项）。错误消息不得出现"无权访问该门店订单"一类可用于探测的措辞。
2. **覆盖校验链每一段**：§6.5 校验链顺序固定（Zod→RBAC→租户→Policy→不变量→事务→事件），每段至少一个可区分错误码；Policy 段需区分 `需确认卡` / `需 step-up` / `需审批` / `拒绝` 四种结局（ADR-05 #4/#11），否则 AI Runtime 无法据以走 §9.4 的分支。
3. **错误载荷受脱敏约束**：错误详情会进日志、进审计、并作为 `tool_result` **回传给 LLM**（ADR-05 #6）。故错误信封不得回显原始 `args` 中的 PII/secret——请说明它如何与 A1 的 `data_classification` / `input_redaction` 联动。

### 2.5 `dry_run` 的响应形状

§6.5：不变量段"dry_run 在此返回预演结果"。预演结果走 `{ok, data}` 的哪种形状？与真实执行的 `data` 是同一类型还是独立类型？**必须可区分**——否则调用方无法判断"这是预演还是已执行"，AI 侧尤其危险。

### 2.6 `idempotency_key` 的作用域与 A1 `idempotent` 的关系

A1 已落 `idempotent: boolean` 与"`offline_mode !== 'denied' ⟹ idempotent`"。请说明：key 的格式与生成方；作用域（per org / per store / per command / 全局）；`idempotent: false` 的命令是否允许携带 key、重放时行为为何。ADR-04 #5 的离线回放去重依赖它。

## 3. 通过标准

- [ ] 两个信封均落地；线路载荷与命令信封在**类型上不可互相构造**（机制可证，非命名约定）。
- [ ] `args` / `confirm_ref` 互斥有实际断言（构造二者并存 → 解析失败）。
- [ ] `via` 四值穷举；`edge_replay` 的 lease 三元组归属已明确（A2 或 A4，不落空）。
- [ ] 错误码表覆盖校验链全段，Policy 段四种结局可区分；跨租户与不存在**同码同文案**（附断言）。
- [ ] 错误载荷脱敏与 A1 `data_classification`/`input_redaction` 的联动已说明并有断言。
- [ ] `dry_run` 预演结果与真实执行结果类型可区分。
- [ ] §2.6 六问逐条书面回应。
- [ ] 沿用 A1 既有手法：`.strict()`、TSDoc 注明 spec/ADR 条款号、非法值拒绝单测。
- [ ] `pnpm -w typecheck` / `lint` 零错零警；文件 ≤400 行、函数 ≤50 行、嵌套 ≤4。
- [ ] 提交前已 rebase；依赖若有增删双锁文件同步。

## 4. 证据格式

同 A1：PR 描述逐条回应 + 自查清单；`packages/contracts/README.md` 续写语义说明（字段 → spec 条款映射）；测试实跑输出粘贴（**不接受恒真断言**）。

## 5. 不通过

§2.1 或 §2.2 未以**机制**解决（仅靠文档约定或命名）= 不通过。这两条与 A1 的 `offline_allowed` 同类：都是契约形状一松、下游安全保证即失效的位置。
