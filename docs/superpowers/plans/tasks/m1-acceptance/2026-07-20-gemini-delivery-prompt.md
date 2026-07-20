# 给 Gemini 的 PR #48 验收提示词（manpengan 下发用）

> 起草：Claude（设计与门禁）　日期：2026-07-20
> **本文件已改写**：初稿是「催开 PR + seed.sql 四处自查」。起草期间 Gemini 自行开了 [PR #48](https://github.com/manpengan/laundry-desk/pull/48)、完成 rebase，并在 `7c983c2` 中把 seed.sql 四处问题**全部自修**。初稿三件事有两件半作废，故改写为对 #48 的实际验收。原稿留档见本文件 git 历史。

---

```text
PR #48 我扫过了。先说做对的，再说卡住的。

【已经做对的三件，不用再说】
1. 你自己开了 PR 并完成 rebase（behind main = 0）。M0 期间在过时工作树
   提交的问题这次没有重演。
2. seed.sql 的四处问题你自己全修了——7c983c2 之后文件头写着五条原则：
   只导出 F2 基础实体、绝不注入 orders/order_lines/garments、绝不用自造
   条码字面量、号段严格 13800000xxx、不依赖 NOW() 等非标准时间函数。
   我原本准备逐条发给你，你比提示词更早想到，这点记一功。
   （尤其"绝不用自造条码"——条码编码方案目前全库零定义，种子里先造一个
     格式会变成既成事实，你避开了。）
3. B1/B3 的内容是齐的：apportionDiscount / yuanToFen / addCents /
   subtractCents / multiplyCents 都在；状态机有 canTransition /
   transition / getValidTransitions 与 InvalidStateTransitionError。

【现在卡住的：workspace-check 红，8 个文件的 prettier】
  apps/server/src/__tests__/platform.test.ts
  apps/server/src/index.ts
  apps/server/src/services/platform.ts
  packages/domain/src/__tests__/money.test.ts
  packages/domain/src/__tests__/status-machine.test.ts
  packages/domain/src/index.ts
  packages/domain/src/money.ts
  packages/domain/src/status-machine.ts

一条 pnpm prettier --write 的事，但请注意后果：workspace:check 是
format:check && lint && typecheck && test && build 的**串行链**，
卡在第一步意味着 lint / typecheck / test / build **一次都没跑**。
所以你 PR 里关于测试与类型的任何声明目前都只有本地证据、CI 零验证。

顺带一句：这是本周第二个 AI 栽在同一处（Grok 的 #41 同样卡在
prettier 第一步）。推送前跑一次 pnpm -w workspace:check，别让 CI 替你发现。

【需要你书面说明的两点（PR 描述里补）】
1. B3 状态机的**穷举方式**。任务书写明「所有非法转移必须全被拒绝——
   这是本项的核心价值」。你有 12 个 it 块，请说明是逐条列举还是
   it.each/循环覆盖全部 status × status 组合，以及组合总数是多少。
   若不是全组合覆盖，请补到全覆盖。
2. B1 的**浮点防线**。任务书要求「任何浮点出现即测试失败」。请指出
   是哪条断言在守这个，并按红线 3 人为破坏一次确认它真会红。

【C7 的问题：你跳了闸，需要一个返工计划】
C7 platform 在任务书里是【等 contracts@v0.1.0 冻结后】那一栏，依赖
A2（统一信封 + 错误码表）与 A6（首批命令定义）。这两组**都还没冻结**
——A2/A4 的评审单我刚发出，Codex 还没动手。

你现在的 apps/server/src/services/platform.ts 是一层裸 service：
  - 引了 @laundry/contracts 的 PII_QUERY_MAX_RESULT_ROWS（这点对，
    用的是已冻结的 A1）
  - 但**没有统一信封** {ok,data}|{ok,error}
  - **没有 Zod 入参校验**
  - **没有 defineCommand 注册**，不在命令总线上
  - apps/server/src/index.ts 直接暴露 service

最后一条撞到架构验收标准：「架构测试（依赖规则 lint）证明 apps 层
**无法绕过总线直调 service**」。C1 命令总线是 Codex 的活、还没建，
所以你现在也接不上——我不认为你该把它删掉重来，业务逻辑是可复用的。

但要求两条：
  1. **PR 描述里把 C7 明确标注为「契约前置实现，待 A2/A6 冻结 + C1
     总线就绪后重接」**，不要让它以「C7 已完成」的形态进入验收记录。
     否则 A2 冻结时没人记得回来改，它就成了绕过总线的既成事实。
  2. 给一句返工范围评估：A2 信封与 A6 命令定义落地后，platform.ts
     有多少接口面要改。

如果你更愿意把 C7 从本 PR 拆出去单独挂着、等契约冻结再合，也可以——
那样 B1/B3/F2/F3 四项能立刻合入 main，不被 C7 拖住。**我建议这么做**，
理由见下。

【为什么建议拆】
你的 packages/domain 至今不在 main 上，已经产生实际代价：Grok 的
packages/ui 已合入 main 且自带一份 lib/money.ts。因为 domain 不在
main，他引用不到真源只能另写一份——现在仓库里两份金额实现，默认
货币符号还相反（你默认全角 ￥ U+FFE5，他默认半角 ¥ U+00A5）。

收敛方向已定：**packages/domain 是真源**（架构 §5：domain 管
「计价、状态机、账目口径」，金额格式化属账目口径）。packages/ui 的
MoneyText 应引用你的 formatFen 并传半角符号，不是另写一份。
Grok 的场景区分判断本身是对的（web 半角好看、热敏打印 GBK 必须全角），
保留为调用方传参即可。

但 packages/ui 是 Grok 的地盘——**这次 PR 你不要动它**，收敛我另发他一条。
你只需要让 domain 尽快进 main，他才有真源可引。

【下一步】
A2 与 A6 一冻结我就通知你重接 C7。按新放行语义，每组通过即冻结、
下游立即可依赖，不必等 tag。两份评审单已在 main：
  docs/superpowers/plans/tasks/m1-acceptance/a2-envelope-and-errors.md
  docs/superpowers/plans/tasks/m1-acceptance/a4-edge-bridge-protocol.md

先修 prettier，再决定 C7 是拆出去还是留在本 PR 并加标注。
```

---

## 配套：给 Grok 的金额收敛（A4 通过后与 D 包一并下发，不单独打断他）

`packages/ui/src/lib/money.ts` 改为引用 `@laundry/domain` 的 `formatFen`，半角/全角差异以调用方传参表达（`formatFen(cents, { symbol })`），不保留第二份实现。理由：架构 §5 定 `packages/domain` 管账目口径；两份实现会在分摊取整规则变更时漂移。其场景区分判断本身是对的，保留。

**前置**：Gemini 的 `packages/domain` 必须先进 main，否则 Grok 无真源可引。

## 门禁侧待办（我的）

- **连续两个 AI 卡在 `workspace:check` 第一步的 prettier**（Grok #41、Gemini #48）。这不是个人疏忽而是流程缺口——串行链把格式检查放在最前，一红则 lint/typecheck/test/build 全不跑，等于 CI 对该 PR 零验证。拟在 PR checklist 模板加一条硬性自查「推送前本地跑 `pnpm -w workspace:check`」，并评估是否值得给仓库加 pre-commit 格式化钩子。
