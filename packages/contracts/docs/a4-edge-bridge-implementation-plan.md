# A4 Edge Bridge Protocol Implementation Plan

> 执行方式：直接采信 M0-2 的 32/32 通过语义；每个协议边界先写可失败的 Vitest/TypeScript 断言，再补最小 Zod 契约。

**目标：** 冻结 Server↔Edge 的能力票据、执行回执、offline grant、Primary lease 与版本化离线队列信封，供 Grok D2/D3/D4 实现签名、加密队列和打印回执。

**边界：** 只修改 `packages/contracts/**`。不实现密码签名、密钥保存、实际验签、lease 头行锁签发、可信时钟状态机、队列存储或领域回放；这些运行时语义沿用 M0-2 与后续 D2/D3。

## 冻结裁定

- 签名采用外层包封：`{ protocol_version, payload, sig }`。四类协议各有固定 domain separator；签名输入为 `domain + "\n" + canonical({ protocol_version, payload })` 的 UTF-8，`sig` 永不参与自身签名。
- canonical JSON 使用递归 UTF-16 字典序字段、拒绝访问器/稀疏数组/额外数组属性/重复或缺省字段、有限安全整数与精确 ISO-8601 UTC 字符串。只有协议专用签发 helper 对外，A4 的二进制 canonical helper 与 A5 canonical args **不共享实现**。
- 线路解析结果只命名为 `*Signature*Candidate`：私有品牌/WeakMap 证明严格解析来源，不证明密码学验签；A4 不定义 `Verified*` 权限类型。
- M0-2 的 Primary lease 必含 `not_after`，并位于 server-signed payload 内。Edge lease 有效性必须继续使用请求前 monotonic anchor、RTT/连续性 fail-closed，禁止以 `Date.now()` 直接判定。
- 能力票据采用同一可信时间模式：签名 payload 另含 `issued_at`，Edge 从 `exp - issued_at` 得到最大本地时长并以请求前 monotonic anchor 建立 deadline；无法证明连续性、RTT 不足或本地 deadline 已到即拒绝执行。
- offline grant 签入 `ttl_ms`，强制 `not_after === issued_at + ttl_ms` 且 M1 上限 12 小时；运行时同样复用可信单调时间，禁止墙钟授权。
- A2 的 `edge_replay` 只表达来源。`lease_id + primary_epoch + per_lease_seq` 由 A4 队列信封独占；它服务幂等、防重放、顺序与审计，不宣称避免物理双交付。
- `queue_envelope_version` 与 `@laundry/contracts` major 独立：低于最低安全版本转恢复/仲裁且禁止自动重放；回滚后见到更高版本转只读恢复模式，禁止盲目降级重放。

## Task 1：基础 schema、canonical 规则与签名品牌

**文件：** `src/edge/primitives.ts`、`src/edge/canonical.ts`、`src/edge/signed-envelope.ts`、对应测试。

- [x] 先断言字段顺序不同产生同一 canonical 输出，签名方/验签方 helper 字节相同；非有限数、非精确 ISO、未知/缺省字段失败。
- [x] 实现外层签名包封与 `protocol_version`；canonical 输入排除 `sig`，使用递归字典序和 UTF-8。
- [x] 定义 server/device signature candidate 私有品牌 + WeakMap 来源，补交叉赋值和 JSON/展开伪造失败断言；候选不冒充已验签对象。

## Task 2：四类协议 payload 与可信时间约束

**文件：** `src/edge/protocols.ts`、`test/edge-protocols.test.ts`、`test/edge-types.test.ts`。

- [x] 先覆盖能力票据、执行回执、grant、lease 的严格正例与非法字段反例。
- [x] 让 lease 的 `not_after` 入 server-signed payload；校验精确 `issued_at + ttl_ms === not_after`。
- [x] 将 capability ticket 与 grant 的签名时长、12 小时 grant 上限及 M0-2 单调时间约束写入 TSDoc，不提供 `Date.now()` 运行时捷径。
- [x] 断言能力票据/lease 只能进入 server-signed 路径，回执只能进入 device-signed 路径。

## Task 3：grant 上界与版本化 replay 信封

**文件：** `src/edge/offline-grant.ts`、`src/edge/queue-envelope.ts`、对应测试。

- [x] 先用 A1 命令定义断言：grant 白名单含 `offline_mode: denied` 命令时构造失败；`primary_lease` 白名单仍标记运行时 lease 必需。
- [x] 无参快照工厂由 A1 模块内部枚举全部已登记 command 并原子封存注册表；其后 `defineCommand()` 失败，工厂拒绝 caller-owned definitions/manifest，grant 解析也拒绝展开/JSON 伪造快照。
- [x] 导出只可收紧的 grant 子集校验器；手工把 denied 校验放松一次，确认该反例测试会红。
- [x] 队列信封承载 A2 wire payload、`queue_envelope_version` 与 replay triad；三元组使用正安全整数 seq，不包含暗示物理双交付防护的名字。
- [x] 兼容判定原子解析实际信封并同时检查 queue 版本与 contracts current/previous major；任一维度不兼容均禁止自动重放。
- [x] README 写清 replay high-water 是 server 持久化运行时状态；契约只保证 tuple 形状与每条消息的正 seq。

## Task 4：文档、门禁与提交

- [x] README 逐条回答 A4 评审单 §2.1–§2.8，并核对 §2.9 措辞红线。
- [ ] 跑 package test/coverage、strict typecheck、lint、format、build、差异检查；A2/主线更新后 rebase 并重跑。
- [ ] 提交、推送并创建 A4 PR，@Claude 结对冻结；仅在 A4 通过后通知 Grok D2/D3/D4 解闸。
