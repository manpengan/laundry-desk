# F1 裁定：`secret` 与 `R5` 解耦

> 裁定：Claude（设计与门禁）　日期：2026-07-20
> 触发：[A1 冻结评审结论](2026-07-20-a1-freeze-verdict.md) F1（P1，A6 开工前必须裁定）
> 依据：ADR-05 #4（R5 枚举）、#12（元数据四字段）、ADR-04 #3（离线禁用项）、架构 §8（审计不落 token/密钥）
> 核验对象：`codex/m1-a1-contract-registry` @ `875ae3c` 的 `schemas.ts` / `definitions.ts`

## 裁定：取选项 ①（解耦），确认 Codex 已落地的形态

`data_classification === "secret"` **不蕴含** `risk === "R5"`。Codex 在「闭环 A1 冻结修复」中已按此改毕（`schemas.ts:71` 注明 `independent of risk`），本裁定确认该形态，无需再改。

## 理由

**一、R5 是按操作类别定义的，不是按入参内容。** ADR-05 #4 原文把 R5 限定为「权限/密钥/备份恢复/审计删除/系统设置」。`identity.login` 带密码、柜台 PIN 快切带 PIN——**入参含凭据，但操作本身不属于该枚举**。焊死会造成错误分类：把一个不需要确认卡、不需要 step-up 的登录动作标成最高危等级，Policy Engine 会据此施加它不该有的流程，且 A6 首批 identity 域第一条命令就会撞上。

**二、解耦零损失。** R5 在 ADR-05 #4 里买的是两件事：不进投影、AI 不可执行。现实现用**独立的 `secret` 轴**在 C4 守卫里保住了两者——`definitions.ts:303–304` 是两条并列判断（`risk !== "R5" && data_classification !== "secret"`），类型层亦为两个独立的 `Exclude`。凭据类命令照样被机械排除在 AI 投影之外，不必假称 R5。

**三、其兜底强于冻结结论的建议，三条全部采纳。**

| 约束 | 评价 |
|---|---|
| `secret ⇒ offline_mode: "denied"` | 对。凭据不入离线队列，合 ADR-04 #3 |
| `secret ⇒ input_redaction` 非空且 **remove-only** | 对，且这条最关键。`mask` / `last4` 用在凭据上是灾难——`last4` 会稳定泄漏尾部字符，对 PIN 这类短凭据近乎明文。只允许整条移除是唯一正确的策略 |
| `secret ⇒` 禁 `examples` | 冻结结论未提，他自己加的。防示例里写进真实凭据格式，采纳 |

## 补充两条（本裁定新增，须落地）

### 补 1（P0，把 F7 的紧迫度往前提）secret 兜底的执行机制可被 F7 静默失效

上述兜底**完全依赖 `input_redaction` 真的生效**。而 [F7](2026-07-20-a1-freeze-verdict.md) 已实测证明：声明路径落在 `transform` / `pipe` 之下时，存在性与类型校验被静默跳过（`resolveInputPath` 的 `unresolved` 分支两边都不管）。

两者相乘的后果是具体的：

```js
defineCommand({
  data_classification: "secret",
  input: z.strictObject({ cred: z.strictObject({ password: z.string() }).transform(o => o) }),
  input_redaction: [{ path: "/cred/password", strategy: "remove" }],   // 路径永不校验
})
```

定义期全绿——`secret` 的三条兜底都"满足"了——但脱敏规则永不匹配，**密码原样进审计日志与 LLM 上下文**，直接击穿架构 §8 的「审计与日志不落 token、密钥」。

故 **F7 的修复时点由「打 tag 前」提前为「A6 落 identity 域命令之前」**。A6 第一批就是 identity，F7 不修则 `secret` 这条轴形同虚设。

### 补 2（A6 须知）契约层无法检测漏标 `secret`

契约不知道哪个字段是密码。`identity.login` 若被标成 `pii` 而非 `secret`，就只受 pii 约束——可 `mask`、可离线、可进投影。这是**标注方的责任，不是校验器能兜的**。

要求：A6 评审单增加一条逐命令核对项——「凡入参含密码 / PIN / token / API key / 备份口令者，`data_classification` 必须为 `secret`」，并在 A6 提交时逐条列出首批命令的分类依据，由我核对。

## 落地清单

- [ ] Codex：README 补一段记录本裁定（F1 要求「二选一并写入 README」），说明 `secret` 与 `risk` 为何是两个独立轴、C4 守卫如何在两轴上分别排除
- [ ] Codex：F7 修复（定义期把 `unresolved` 一并当错误，至少对 `size_measures` 与 `input_redaction` 强制 `resolved`）——**优先级由 tag 前提到 A6 前**
- [ ] Claude：A6 评审单起草时加入补 2 的逐命令核对项
