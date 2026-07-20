# M0 第三轮提示词（manpengan 下发用）

> 日期：2026-07-20　起草：Claude（设计与门禁）
> 前置：main 已全绿（CI 五层修复 + PR #33 修完 Gemini 阻断缺陷）。
> 用法：各 AI 独立会话，先 `git fetch origin && git log --oneline origin/main -3` 确认在最新 main 上。

---

## 给 Gemini（**必须先 rebase，否则会把 main 打回红灯**）

```text
【最高优先级：rebase，在此之前不要提交任何新内容】

你的 gemini/m0-spikes 合并基点是 5d6aedb，那是 CI 五层修复之前的 main。
该分支现在带着三处回退，直接合入会把 main 打回红灯：
  1. build/ 打包资产（icon.ico / icon.svg / installer.nsh）在你分支上不存在，
     且 .gitignore 第 8 行仍是 build/ ——Windows 打包必报
     "cannot find specified resource build/installer.nsh"
  2. .github/workflows/build.yml 缺 rebuild:node 与 postinstall 两步
     ——#27 的 ABI 阻塞会复现，13 个单测全红
  3. tests/e2e/app-smoke.spec.ts 是旧断言 ——E2E 层失败复现

原因不是你写错，是在过时工作树上提交，把 origin/main 已有的修复一并覆盖了。

执行：
  git fetch origin
  git rebase origin/main        # 冲突时一律以 origin/main 侧为准
  # rebase 后自查这三项必须与 main 一致：
  git ls-tree HEAD build/                          # 应有 3 个文件
  grep -c "rebuild:node" .github/workflows/build.yml   # 应为 1
  grep -n "^build/" .gitignore                     # 应无输出

【已由门禁代修的部分——rebase 后你会看到这些已在 main 上，不要重复改】
PR #33 已修复并合入 main：
  - gemini.ts 的 part.functionCalls（复数）→ part.functionCall（单数对象）
    ＋3 处 call.name 空值兜底。SDK 只有单数属性，用复数导致真实路径永远
    取不到工具调用（tsc TS2551 ×4，现已归零）
  - smoke-test.sh 删掉硬编码 DOCKER_BUILDKIT=0 / COMPOSE_DOCKER_CLI_BUILD=0
    （Docker 28+ 已移除 legacy builder，构建无限挂起 >8 分钟）
  - Test 4 假阳性：原以 laundry_owner 执行，被 FORCE RLS 拒绝而非外键拦截，
    且 `|| echo PASS` 对任何非零退出都通过＝永不失败。已改为 laundry_app
    ＋正确 GUC，断言改为校验错误类型（命中 FK 才 PASS，命中 RLS 则 exit 1）
  - init.sql 补 owner 的 maintenance_policy（此前 owner 对数据零可见零可写，
    架构 §4 规定的"迁移用 owner 角色"无法成立）＋三条策略显式补 WITH CHECK
  - .gitignore 加 !tools/spikes/**/evidence/*.log（此前 evidence 被 *.log
    吞掉，findings 里的相对链接在任何 clone 出来的仓库都是死链）
  - run.ts 移除未使用的 ContentPart 导入；mock-server/ 加局部 .eslintrc.cjs
    豁免 no-var-requires（CommonJS spike 服务，改 ESM 会跑不起来）

【你本轮要做的 M0-5 返工】
1. 结论改口径：findings 里"结论：【通过】"改为【待实测】——三个 adapter 全部
   跑在 mock 上，零真实模型调用，与验收单"每 adapter ≥1 模型连续 3 次全绿"
   和"openai-compat 实测 ≥2 家国产厂商"均无证据支撑。标注诚实值得肯定，
   但结论行不能超出证据强度。
2. 补单工具用例——现在只有一个用例（流式＋并行双工具）。
3. generate() 非流式方法三个 adapter 都实现了，run.ts 从未调用过，请补上。
4. 连续 3 次稳定性记录：main() 每 adapter 只跑 1 次，无循环无记录。
5. 六维方言矩阵缺「结束条件」维（stop_reason / finish_reason / finishReason
   全仓零命中）；token 用量列无代码支撑——三个 adapter 都不读 usage /
   usageMetadata，请补读取或删除该列。
6. README 补结果摘要与"git log -p 自查无明文密钥"声明。
7. 三个 adapter 的 mock 返回值 type 未收窄为字面量（tsc TS2416 ×3），请修。

【M0-6 返工】
1. README 补平台清单与 Docker 版本前置依赖（现无任何平台章节）。
2. 冷启动耗时改实测值（现为"约 2-3 秒 / 20-30 秒"估值；门禁实测全流程 39s）。
3. Step A/B/D 三步往返加断言——现在是 `| json_pp || echo "Curl error"`，
   curl 失败仍继续且最终 exit 0。
4. Edge 占位与 server 占位分立（现由单个 mock-edge-server 容器兼任两角色）。
5. 补 M0-1 复用声明（与 Codex 确认，引用其 README）。

【真实 API key】manpengan 会以环境变量提供。拿到前 M0-5 只能停在【待实测】，
这是客观阻塞不是你的问题；拿到后请补真实调用证据并把结论改回【通过】。

完成后 git push，等 CI 绿再开 PR。不要合并任何未过 CI 的分支。
```

---

## 给 Grok（补充修复，实机日前完成）

```text
你的 M0-4 已判**通过**；M0-3 判**有条件通过**——权威 P1/P2/P3/P8 我逐字节复核
过，确实真修好了（CODE128 {B/{C 混合码集在 bin 里实测存在、不干胶条码底边
670<720dot 已出画、9 个边界样张含全角引号转义、LNA-CHECKLIST 已改公网源）。

卡点是复核时新发现的一个阻断级 bug：

【必修 1：¥ 在 GBK 下变成 "?"，三台机全中】
  "¥" U+00A5（半角日元号）不在 GBK 码表，iconv 回落为 0x3f "?"。
  "￥" U+FFE5 才有映射（a3a4）。

  实测字节流：
    xp58-receipt.bin        "合计 ?60.00"    ← 4 处
    dl206-wash-fullvars.bin "@单价@=?45.00"
    gp3120-sticker-fullvars "单价:?45.00"

  7 处调用点：src/xp58-receipt.ts:65,73,74,79、src/dl206-wash.ts:25、
              src/gp3120-sticker.ts:21,26
  改成 ￥ 即可，1 字符 × 7 处。

  为什么必须实机日前修：单价是验收单点名的必测变量，带着这个上实机，
  "全变量正确样张"与"中文无乱码"两条会直接判负，白烧一轮耗材和现场时间。

  同时加一条防回归单测：断言编码后的字节流不含 0x3f。
  现在的测试全是定点字节断言，没有任何一条检查这个，金额渲染零覆盖——
  这正是该 bug 溜过去的原因。

  另：findings 里"金额…仅渲染为 ¥x.xx 文本"这句在线上是假的，一并订正。

【强烈建议 2：预生成加长 feed 的切刀变体】
  切前走纸只有 3 个 LF ≈ 11mm，而热敏机切刀距打印头通常 10-25mm，
  大概率切进内容。CHECKLIST-dl206.md:50 留了"切前是否需要额外 feed"的
  回填位，但没有预生成变体 bin ——现场撞上只能改代码重生成。
  建议照 ESC i 的做法再出一个 feed(6) + GS V 66 n（走纸到切纸位再切）变体。

【可延后 3】
  - estimateCode128Dots（lib/escpos.ts:124）公式漏了起始符/校验符/单侧静区
    （实际 11n+55，代码 11n+23），且把 {B 两个 ASCII 当两个符号。本次结论
    碰巧仍正确（超 384dot），但系统性偏低，换条码数据可能误判"装得下"。
  - src/dl206-wash.ts:74-75 注释说"fallback cutters 在全切之后发出"，
    实际只发了 cut(0)，注释陈旧。
  - 三个函数超 50 行红线：src/generate-all.ts:57 main() 89 行、
    m0-4-edge/ab-upgrade/drill.mjs:146 cmdInstall() 86 行、:269 cmdRollback() 65 行。
    （属 tools/spikes/ 而非 src/，是否豁免由 manpengan 定。）

【澄清三点我此前的误判】
  - 切刀指令本来就是对的：1d 56 00 全切 / 1b 69 ESC i / 1d 56 01 半切，均合法
  - 变量不是缺失而是超集：不干胶正好 22 个，水洗唛实现 23 个，且 lib/variables.ts、
    CHECKLIST-dl206.md、findings 三处都记录了与顺科计数的出入——验收单本就
    要求说明出入，属满足而非违反
  - RUNBOOK 证据要求已达标（明写"短录屏优先，不要只交静态照片"并列出四个画面）

【rebase 提醒】
你的分支也基于旧 main，push 前先 git fetch origin && git rebase origin/main，
自查 build/ 三资产、workflow 的 rebuild:node、e2e 断言三项与 main 一致。

完成后 push，等 CI 绿再开 PR。实机日等 manpengan 排期。
```

---

## 给 Codex（rebase 后合入基座）

```text
main 已全绿（CI 五层问题全部修复，PR #30/#31/#33 已合入）。
你的 PR #29（monorepo 基座）我已评审通过：
  - 完全没碰 src/，v1 与 v2 隔离干净
  - v2 脚本全部加 workspace: 前缀，v1 的 test/build/lint 原样不动
  - 独立 V2 Foundation workflow 且 paths 过滤，不打扰 v1
  - tests/foundation/workspace.test.mjs 自带地基回归保护（pnpm 版本、
    workspaces 路径、turbo 任务依赖、CI action 版本、.turbo/ 忽略）
  - 此前 Build/Release 失败是纯继承 main 的 #27，非你引入

请执行：
  git fetch origin && git rebase origin/main
  git push --force-with-lease
rebase 后 Build/Release 应转绿。CI 全绿后我合入，另外两家就能在基座上接活。

合入后即可继续 A1–A7 contracts。提醒两点：
  1. 契约评审是结对进行——每完成一组就找我评审，不要攒到最后一次性提交
  2. M0-6 的 compose 我已修好（BuildKit 挂死 + Test 4 假阳性 + owner
     maintenance_policy），你的本地 PG 可以按 D3 继续用 M0-1 自带 compose，
     待 M0-6 复验通过后全队统一切换
```
