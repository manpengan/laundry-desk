# 给 Gemini 的交付提示词（manpengan 下发用）

> 起草：Claude（设计与门禁）　日期：2026-07-20
> 起因：`feat/m1-gemini-domain` 已完成 B1 / B3 / F3 / F2 四项但**未开 PR**，分支落后 main 25 个 commit。四项完成品未进 main，`packages/domain` 对全队不可见。

---

```text
你的 B1、B3、F3、F2 四项都完成了，质量我扫过——但它们**全压在
feat/m1-gemini-domain 分支上，没开 PR**。M1 五项你做完四项，进 main 的是零。

这有实际代价，不只是流程问题：Grok 的 packages/ui 已合入 main，里面自带
一份 lib/money.ts。因为你的 packages/domain 不在 main 上，他引用不到真源，
只能自己再写一份——现在仓库里有两份金额实现，默认货币符号还相反
（你默认全角 ￥ U+FFE5，他默认半角 ¥ U+00A5）。这个分叉的根因就是
你的东西没送出来。

【第一件事：rebase，别直接开 PR】
你的分支落后 main **25 个 commit**。这正是红线 2 要防的——M0 期间你在
过时工作树上提交，覆盖了 main 已有的 CI 修复（build/ 打包资产、workflow
rebuild:node、e2e 断言三处回退）。25 个 commit 的落差，直接开 PR 风险更大。

  git fetch origin && git rebase origin/main

这 25 个 commit 里有几件与你直接相关：
  - packages/contracts A1 命令注册表已冻结并合入（PR #43）
  - packages/ui 设计系统已合入（PR #41），含 MoneyText / StatusBadge
  - Grok 的 D1 Electron 壳、D5 A/B 骨架已合入
  - tools/compose 相关的门禁修复

rebase 后先跑一遍 pnpm -w workspace:check，确认没被 main 的变化打破。

【第二件事：开 PR】
四项一个 PR 即可（19 个文件不算大）。但 PR 描述里请把 **F3 compose 转正**
单独标出来——门禁已复验通过，它一合入全队就要切换到 tools/compose/，
这是需要广播的事。

PR 描述按 pr-checklist-template.md 走，另外这两点请显式写：
  1. B3 状态机的**穷举方式**——任务书写明「所有非法转移必须全被拒绝，
     这是本项的核心价值」。你有 12 个 it 块，请说明是逐条列举还是
     it.each/循环覆盖全部 status × status 组合，以及组合总数。
  2. B1 的浮点防线——任务书要求「任何浮点出现即测试失败」。请指出
     是哪条断言在守这个。

【第三件事：seed.sql 有四处要先自查】
先说清楚：tools/seed/data.ts 我看了，F2 的正经内容是齐的——SeedOrg /
SeedStore / SeedStaff / SeedCustomer / SeedPriceItem / SHUNKE_PRICE_CATEGORIES
都在，手机号也严格在 13800000xxx 段。**问题只在 seed.sql 这一个导出文件。**

  1. 头部注释与内容完全不符。注释写「包含：1 Org / 1 Store / 3 员工 /
     3 虚构客户 / 顺科 11 服务大类价目字典」，但文件里一个都没有——
     实际只 INSERT 了 orders / order_lines / garments。这是红线 1 在
     文档层的同类问题：声明超出了内容。
  2. 插入的数据超出 F2 范围。F2 是「1 org / 1 store / 管理员+店员 /
     价目字典」，订单与件级数据不属于种子范围，会污染「全新安装」基线
     （备份还原验收要用这个基线）。
  3. 自造了条码格式 BC_SEED_001。**条码编码方案目前全库零定义**——
     spec 只声明 garments.barcode UNIQUE，ADR-03 只说它是打印/上挂/
     催取/店厂交接的操作主键，怎么编码没有任何规定。种子里先造一个
     格式会变成既成事实。我正在起草条码编码方案的 ADR，在它出来前
     seed 里不要出现 barcode 字面量。
  4. 「PostgreSQL / SQLite 兼容」的声明不成立——文件里用了 NOW()，
     SQLite 没有这个函数（它用 CURRENT_TIMESTAMP / datetime('now')）。
     要么改语句，要么把兼容声明去掉。

建议做法：seed.sql 收敛为只导出 data.ts 里真正属于 F2 的实体，
或者干脆先不出 SQL、留待 A3 租户表矩阵冻结后再生成——A3 一冻结，
三元组合键 (org_id, store_id, id) 与 RLS 策略才有确定形状。
你现在的 ON CONFLICT 三元键写法方向是对的（合 ADR-03 #6），
但表结构目前是你自己推的。

【金额双实现：这次 PR 不要动 packages/ui】
收敛方向已定：**packages/domain 是真源**——架构 §5 写着 domain 管
「计价、状态机、账目口径」，金额格式化属账目口径。packages/ui 的
MoneyText 应引用你的 formatFen 并传半角符号，而不是另写一份。

但 packages/ui 是 Grok 的地盘，**这次 PR 你不要动它**。先把你的东西
落进 main，收敛我另发 Grok 一条。Grok 那份的场景区分是对的
（web 用半角好看，热敏打印 GBK 必须全角），保留为调用方传参即可，
不需要两份实现。

【下一步】
C7 platform 仍等 A2（统一信封 + 错误码）与 A6（首批命令定义）。
两份评审单我已经提前发出并合入 main：
  docs/superpowers/plans/tasks/m1-acceptance/a2-envelope-and-errors.md
  docs/superpowers/plans/tasks/m1-acceptance/a4-edge-bridge-protocol.md
按新放行语义，A2 与 A6 一通过我就通知你起 C7，不必等 tag。

【四条红线】
1. 证据即结论——没实测就写「待实测」（seed.sql 头部注释正是反例）
2. 提交前 rebase——你现在落后 25 个 commit
3. 断言必须能失败——写完先人为破坏一次
4. 增删依赖同时更新 package-lock.json 与 pnpm-lock.yaml

先 rebase，再开 PR。
```

---

## 配套：给 Grok 的金额收敛（A4 通过后与 D 包一并下发，不单独打断他）

`packages/ui/src/lib/money.ts` 改为引用 `@laundry/domain` 的 `formatFen`，半角/全角差异以调用方传参表达（`formatFen(cents, { symbol })`），不保留第二份实现。理由：架构 §5 定 `packages/domain` 管账目口径；两份实现会在分摊取整规则变更时漂移。其场景区分判断本身是对的，保留。
