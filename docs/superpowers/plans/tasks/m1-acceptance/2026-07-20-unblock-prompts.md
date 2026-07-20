# M1 解闸提示词（Grok / Gemini，manpengan 下发用）

> 日期：2026-07-20　起草：Claude（设计与门禁）
> 起因：复核发现 [M1 开工提示词](../2026-07-20-m1-kickoff-prompts.md)把三项**不依赖任何契约组**的任务误列在「等 contracts@v0.1.0 冻结后」闸内，导致 Grok 与 Gemini 在 E2 / B1·B3·F3 交付后空转。这是我方调度失误，特此解闸。
> 同时下发新的[放行语义](README.md)：tag 是封版标记，不是放行闸；**每组契约通过即冻结、下游立即可依赖**。

---

## 给 Grok（端与硬件）

```text
两件事：一是你 PR #41 的 CI 红灯，二是给你解两项闸。

【PR #41 · workspace-check 红了】
失败在 workspace:check 的第一步 prettier：

  [warn] packages/ui/README.md
  Code style issues found in the above file.

一条命令的事。但请注意一个后果：workspace:check 是
format:check && lint && typecheck && test && build 的串行链，
卡在第一步意味着后面四步一次都没跑。所以你 Test plan 里勾的
「packages/ui tsc + 11 unit tests ✓」「eslint --max-warnings=0 ✓」
目前只有本地证据，CI 侧零验证——你把 CI 两栏留空没勾是对的，
按红线 1「证据强度 ≥ 结论强度」这处理没问题。修完等两条线都绿我再验收。

E2 本身我扫过一遍，MoneyText 作全局唯一金额渲染、StatusBadge 色+形
双编码这两条方向对，细节等 CI 绿了我逐条走查。

【解闸：D1 与 D5 现在就能开工，不必等契约】
开工提示词把 D1–D5 整块塞进了「等 contracts 冻结后」，这是我写错了。复核结论：

  D1 Electron 壳 —— 零契约依赖。它是安全基线（nodeIntegration:false、
     contextIsolation:true、sandbox:true、webSecurity:true、最小 preload +
     sender 校验、禁任意导航/新窗口/外链、权限默认拒绝）+ app:// 内置签名
     SPA + 断网冷启动。提示词自己写着「你 M0-4 已逐项验证过，直接转正」——
     既然是转正，本就不需要契约。现在开工。
  D5 A/B 双槽 + 健康检查 + 升级前快照 + 回滚判定骨架 —— 承接 M0-4，
     同样零契约依赖。现在开工。

【仍在等契约的】
  D2 配对与签名 / D3 SQLCipher 加密队列 / D4 打印模板与回执 —— 等 A4（Edge 桥协议）
  E1 登录页 + PIN 快切 —— 等 A5（会话/CSRF）+ Codex 的 C6
  E3 权限门控路由骨架 —— 等 A6（首批命令定义）

【放行语义变了，对你有利】
原规矩是「A1–A7 七组全绿才打 tag contracts@v0.1.0，然后放行」。
现改为：tag 只是最终封版标记，**每组评审通过即宣告该组冻结、下游立即可依赖**。
所以 A4 一过你就能起 D2/D3/D4，不必等 A7 的 OpenAPI 快照做完。
我会在每组合入时通知你。

【红线不变】
Edge 内不写业务校验；浏览器不持有敏感状态（IndexedDB 只缓存 UI/字典）；
金额渲染一律走 MoneyText；增删依赖同时更新 package-lock.json 与 pnpm-lock.yaml。

先修 #41 的 prettier，然后 D1 开工。
```

---

## 给 Gemini（领域实现）

```text
你的 B1 金额工具、B3 状态机、F3 compose 转正已提交（分支 feat/m1-gemini-domain），
我会在走查后给验收意见。先给你解一项闸，别空转。

【解闸：F2 种子数据现在就能开工】
F2 在开工提示词的【工具链】栏、本就没有闸标记，但你做完 B1/B3/F3 后
把它一起停下了。复核结论：F2 的**数据内容**零契约依赖，现在就能出——

  1 org / 1 store / 管理员 + 店员 / 价目字典
  （参考顺科 11 服务大类 × 品类；手机号一律用 13800000xxx 虚构段）

分两步走，避免返工：
  第一步（现在）：把数据集本身定出来——服务大类、品类、价目条目、
    两个角色的权限点集合。用纯数据文件（JSON/TS 常量）表达，不写落库逻辑。
  第二步（等 A3 租户表矩阵冻结）：再写 seed 落库脚本，届时三元组合键
    (org_id, store_id, id) 与 RLS 策略才有确定形状。

第一步的产出物本身就是第二步的输入，不会白做。

【仍在等契约的】
  C7 platform（settings、store_features flags、审计查询只读）——
  等 A2（统一信封 + 错误码表）+ A6（首批命令定义），过 Codex 二审。

【放行语义变了】
原规矩是七组全绿才打 tag、然后放行。现改为：tag 只是最终封版标记，
**每组评审通过即冻结、下游立即可依赖**。A2 与 A6 一过我就通知你起 C7，
不必等 A3/A4/A5/A7。

【四条红线不变】
1. 证据即结论——没实测就写「待实测」，不写「通过」
2. 提交前 git fetch origin && git rebase origin/main
3. 断言必须能失败——写完先人为破坏一次确认它真会红
4. 增删依赖同时更新 package-lock.json 与 pnpm-lock.yaml

F2 第一步现在开工。
```

---

## 下发注意

- 两份可同时发，互不依赖。
- Grok 那份的第一件事（修 #41 prettier）是当前唯一红灯，优先。
- 本次解闸**不改变任何人的总任务量**，只是把已有任务的开工时机提前。
