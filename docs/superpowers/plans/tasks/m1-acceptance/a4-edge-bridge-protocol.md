# A4 评审单：Edge 桥协议类型

> 主责：**Codex**（Zod 落地）　评审：Claude（语义与冻结）　落点：`packages/contracts`
> 依据：架构 §10（Edge 安全模型/签名三方向/离线两级授权/可信时间契约）、§11（离线矩阵）、ADR-04 全条款（尤 #6 grant、#7 lease）、ADR-08 #1（兼容单位）
> 底稿：**直接采信 [M0-2 实测](../../../../research/2026-07-19-v2-m0-findings.md#m0-2-primary-lease-时序--可信时间主责codex)（32/32 通过），不重新设计**
> 公共规则见 [README](README.md)。**本单在 Codex 动手前发出**——A4 冻结即解 Grok 的 D2/D3/D4 三项闸，是当前下游阻塞最多的一组。

## 1. 范围

四类协议对象一次冻结：**能力票据**（server→Edge）、**执行回执**（Edge→server）、**offline grant**、**Primary lease**；外加**队列信封版本化**。

M0-2 已把 lease 的时序语义实测跑通（双 owner 并发恰一张、无 ACK 等待 109ms 拒/110ms 签、RTT≥TTL fail-closed、旧 epoch 回放进仲裁、`src/` 有效性路径静态无 `Date.now()`）。**A4 的任务是把已验证的运行时语义固化成类型，不是重新论证语义。**

## 2. 预登记形状陷阱（Codex 提交时必须逐条回应）

### 2.1（P0）lease 字段清单三处不一致，`not_after` / `sig` 归属未定

| 出处 | 字段数 | 含 `not_after` | 含 `sig` |
|---|---|---|---|
| ADR-04 #7 | 7 | ✗ | ✗ |
| 架构 §10 清单行 | 7 | ✗ | ✗ |
| §10 正文 | — | ✓（「`not_after` 一并入签名对象」） | — |
| M1 开工提示词 | 9 | ✓ | ✓ |
| **M0-2 实测 `signed-lease-sample`** | — | ✓ | — |

照清单实现会漏 `not_after`，Edge 只能自行重算 `issued_at + ttl_ms`——多一个出错点，且与 §10「`not_after` 一并入签名」相悖。

**裁定**：以 M0-2 实测底稿为准，`not_after` **必须入签名对象**。请明确 `sig` 是对象内嵌字段还是外层包封（见 §2.2），并在 TSDoc 注明本表的不一致已由本单裁定收口。

### 2.2（P0）签名覆盖范围与 canonical 序列化必须给机制

M0-2 偏差段明写：「Edge 必须先按**版本化 canonical message** 验签」。但 canonical 形式在 spec 与 ADR 中均无定义。

若 `sig` 是对象内字段，**签名无法覆盖自身**——必须定死：是「排除 `sig` 后按 canonical 序列化再签」，还是 `{payload, sig}` 外层包封（payload 整体入签）。两种都可行，但**不能留给实现方猜**：验签方与签名方对 canonical 的理解差一个字节，全部验签失败或（更糟）出现可延展签名。

**要求**：给出 canonical 规则（字段序、数值/时间戳表示、缺省字段处理）与版本号位置。此项与 ADR-05 #10 的 canonical args 冻结同类，请说明二者是否复用同一套 canonical 实现。

### 2.3（P0）三条签名线方向相反，类型上必须不可互换

§10 定义三条线，签名方向两两不同：

| 线 | 签名方 | 验签方 |
|---|---|---|
| 能力票据 | **server 私钥** | Edge |
| 执行回执 | **设备私钥** | server |
| Primary lease | **server 私钥** | Edge |

若三者共用一个泛型 `Signed<T>`，把设备签的回执喂进验 server 签名的路径（或反之）在类型上完全合法。这与 A2 §2.1「线路载荷 vs 命令信封」同类：**要机制，不要命名约定**——参照 A1 `ContractDefinition` 的 brand + WeakMap 手法，或按签名方分立不可互换的品牌类型。

### 2.4（P0）A1 的 `offline_mode` 与 grant 命令白名单，关系未定

两处都在表达"这条命令能不能离线执行"，但归属不同：

- **A1 `offline_mode`**（已冻结）：`denied | grant | primary_lease`——**命令的静态属性**，出厂线
- **offline grant 的命令白名单**（§10、ADR-04 #6）：staff×device 短时授权携带——**动态授权**

若两者被定义成互不相干的判据，一张 grant 就能让 `offline_mode: denied` 的命令离线执行（退款、储值、设置修改、AI——ADR-04 #3 的全部禁离线项），Edge 也不知道该读哪个。

**裁定**：**A1 的 `offline_mode` 是上界，grant 白名单只能在其内收窄**——`grant.allowed_commands ⊆ { c : c.offline_mode !== 'denied' }`，且 `offline_mode === 'primary_lease'` 的命令即使在白名单内仍额外要求有效 lease。契约包须导出该子集校验器（同 ADR-09 决策 3 的"只可调严"手法），并附断言：白名单含 `denied` 命令 → 构造失败。

### 2.5（P1）能力票据的 `exp` 判定用什么时钟——可信时间契约有真空

ADR-04 #7 与 §10 对 **lease** 规定了完整的可信时间契约（禁 `Date.now()`、`local_deadline = request_start_mono + ttl_ms − safety_margin_ms`、锚点取发起请求前、RTT≥TTL fail-closed、连续性不可证即失效）。

但能力票据 `{action, job_id, staff_id, device_id, origin, exp, nonce}` 的 `exp` **没有任何对应规定**——它同样短时、同样在 Edge 侧判定、同样面临时钟回拨。M0-2 的静态检查只覆盖了 lease 有效性路径。

**要求**：明确票据 `exp` 是否共用 lease 的可信时间契约。若共用，写进类型的 TSDoc 并纳入同一静态检查；若不共用，说明为何票据可以用墙钟（例如：票据仅授权单次动作且有 `nonce` 防重放，过期判定放宽的风险边界在哪）。**不接受沉默**。

### 2.6（P1）承接 A2 §2.3：`edge_replay` 的 lease 三元组归谁收

[A2 评审单](a2-envelope-and-errors.md) §2.3 已把这条挂起并明令"勿两边都不收"：`actor.via === 'edge_replay'` 时是否携带 `lease_id + primary_epoch + per_lease_seq`（ADR-04 #7 要求离线高危命令绑定三元组）。**A4 给出最终归属**：A2 的信封收，还是 A4 的队列信封收，还是两处各存一份（若是，说明一致性如何保证）。

### 2.7（P1）队列信封版本化与 ADR-08 兼容单位的关系

ADR-08 #1 定「兼容单位 = contracts 协议 major」。离线队列里可能躺着 Edge 升级前入队的旧版本信封（ADR-08 另有"最低安全版本"与 A/B 回滚）。

请明确：信封版本号与 contracts major 是同一个数还是两套；回放遇到低于最低安全版本的信封如何处置（拒绝？转仲裁？）；**降级回滚后遇到更高版本信封**如何处置——A/B 双槽回滚是 Grok D5 的既定能力，这个方向必然发生。

### 2.8（P1）replay seq 水位语义（M1 四项遗留之一）

M0-2 偏差段：「回放必须维护**每 lease 高水位**；乱序、精确重复、同 seq 内容碰撞及已 release lease 均不能再次触发领域写入」。

请判定该水位是**契约层可表达**（如队列信封携带 `per_lease_seq` 且契约约束其单调性）还是**纯运行时状态**。若纯运行时，说明契约层为回放去重提供了什么最小保证。

### 2.9 措辞红线：`epoch`/`seq` 不防物理双交付

ADR-04 #7 专门做过措辞修正——三元组职责限于**幂等、防重放、顺序与审计归属**；**防物理双交付依赖签发串行化、不重叠 lease、可信本地截止三件事**。

类型命名与 TSDoc **不得暗示**该三元组具备防双花能力（禁 `antiDoubleSpend` 一类命名）。ADR 专门改过措辞说明此处已踩过：字段名一旦误导，后人会据以放松真正的防线。

## 3. 通过标准（逐条判定，全绿才进 A5）

- [ ] 四类协议对象 + 队列信封全部落地；`not_after` 入签名（§2.1）。
- [ ] canonical 规则明确且**与验签方对齐可测**（§2.2）：附「签名方 canonical 输出 == 验签方 canonical 输入」的断言。
- [ ] 三条签名线在类型上不可互换（§2.3），机制可证而非命名约定。
- [ ] `grant.allowed_commands ⊆ offline_mode !== 'denied'` 校验器落地，附白名单含 `denied` 命令即构造失败的断言（§2.4）。
- [ ] §2.5–§2.8 四点**逐条书面回应**（PR 描述或 `packages/contracts/README.md`）——采纳或反对均可，不得沉默。
- [ ] §2.9 措辞核对：搜索类型定义与 TSDoc，确认无暗示防双花的命名。
- [ ] 沿用 A1/A2 既有手法：`.strict()`、TSDoc 注明 spec/ADR 条款号、非法值拒绝单测。
- [ ] `pnpm -w typecheck` / `lint` 零错零警；文件 ≤400 行、函数 ≤50 行、嵌套 ≤4。
- [ ] 提交前已 rebase；依赖若有增删双锁文件同步。

## 4. 证据格式

同 A1/A2：PR 描述逐条回应 + 自查清单；`packages/contracts/README.md` 续写语义说明（字段 → spec 条款映射）；测试实跑输出粘贴（**不接受恒真断言**——M0 教训 3）。

**额外一项**：§2.4 的子集校验器请附**可证伪性验证**——人为把校验改松一次，确认对应断言变红（A1 冻结评审用的是同一手法，5 处变异全红）。

## 5. 不通过

§2.1–§2.4 任一未以机制解决 = 不通过，退回重提。这四条与 A1 的 `offline_allowed`、A2 的租户自报同类：**契约形状一松，下游安全保证在入口处即失效**。其中 §2.4 是最危险的一条——它一松，ADR-04 #3 的全部禁离线项（退款、储值、办卡、设置、AI）都能被一张 grant 放行。

## 6. 冻结后立即解闸

A4 通过即通知 **Grok** 开工 D2（配对与签名）、D3（SQLCipher 加密队列骨架）、D4（签名打印模板 + XP-58 执行 + `print_jobs` 回执）——按[放行语义](README.md)不必等 tag。
