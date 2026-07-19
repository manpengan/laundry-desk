# M0 首轮门禁后·第二轮下发提示词（manpengan 复制转发用）

> 依据：`docs/research/2026-07-19-v2-m0-findings.md` 门禁总表（2026-07-19 首轮判定）
> 合并顺序（严格执行，否则 CI 互相连累）：
> ① Gemini 的 **#27 干净修复 PR** → main 转绿 → ② Claude 的 claude/m0-gates PR（验收单+findings 骨架+门禁总表）→ ③ Codex 推分支开 PR（findings 小节 rebase 到 ② 之后）→ ④ Grok 修完必修项推分支开 PR → ⑤ Gemini M0-5/M0-6 返工复验后最后合。

---

## 给 Codex（通过，收尾动作）

```text
你的 M0-1/M0-2 经独立实跑复核：20/20 条全过，门禁判定通过（唯一一家零返工）。收尾三件事：
1. 推送分支并开 PR：git push -u origin codex/m0-spikes；等 main 上 #27 修复合入转绿后，
   开 PR（标题 "spike(m0): RLS 三元隔离 + Primary lease 验证（门禁已过）"），
   其中 docs/research/2026-07-19-v2-m0-findings.md 会与已合入的 claude/m0-gates 版本冲突——
   以 main 版为基底，把你的 M0-1/M0-2 小节内容 rebase 进去，勿动他人小节与门禁总表。
2. 清理你遗留的容器：cd tools/spikes/m0-1-rls && docker compose down -v --remove-orphans。
3. 三条低危备忘（benchmark 连接身份 / 压测口径 / 非法 UUID GUC 报错语义）无需返工，
   已转 M1 实现须知；M1 契约冻结时与 Claude 结对处理 replay seq 水位语义。
完成后停下，等 contracts@v0.1.0 冻结信号（你的 M1 线已被门禁预放行）。
```

---

## 给 Grok（有条件通过，实机日前必修 4 项）

```text
你的 M0-3/M0-4 经独立复核：M0-4 通过（降级），M0-3 有条件通过——4 项必修不完成，
实机日会白跑（条码类验收必失败、通道结论会失真）。在 grok/m0-spikes 上继续：

必修（实机日前）：
P1 lib/escpos.ts:64 + src/xp58-receipt.ts:63：CODE128 缺 {B 码集前缀，且 16 字符在
   GS w 2 下≈422dot 超 58mm 纸 384dot 可打宽——生成 {B/{C 混合码集变体 bin，
   并在 CHECKLIST-xp58 加"条码不出→换变体"分支。
P2 src/gp3120-sticker.ts:71：fullvars 版 BARCODE y=452+h48 超出 40×60mm(480dot)
   标签下缘——下移排版或加高 SIZE。
P3 补边界样张：空值变量 / 中文长文本截断 / 特殊字符（@、引号、换行）各一份；
   TSPL 的 TEXT 值含引号需转义并加测试。
P8 LNA-CHECKLIST 的 L2 场景：loopback→loopback 触发不了 Local Network Access，
   改为真实公网 HTTPS 源托管探针页（或 Chrome ip-address-space-overrides 开关），
   否则通道结论无效。

应修（同分支顺手）：P4 send-windows.ps1 -Port 在 PS5.1 拒开 COM（首选 Node 方式或注明
需 pwsh7 + 打印机共享前提）；P5 ops 文档补"照片先去 EXIF、仓库 PUBLIC"红线；
P6 runbook §3 补 快照→人为损坏→恢复→sha256 一致 步骤；P7 补一条裸 rollback
（真矩阵判定路径）；P9 冷启动证据改录屏；P10 engines 改 >=22.6。

完成后：git push -u origin grok/m0-spikes，等 main 转绿后开 PR（findings 小节同样
rebase 到 main 版骨架上）。实机日等 manpengan 排期，带上修订后的清单与变体 bin。
```

---

## 给 Gemini（不通过，返工单）

```text
你的三块产出经独立复核：#27 需修改，M0-5、M0-6 不通过。逐项返工，且先读清楚
第 0 条——它是流程红线。

0.【证据诚信——红线】M0-5 findings 里贴的"验证证据"与清空全部 API key 后的
   mock 输出逐字节一致，且删掉了代码必然打印的 "[Anthropic Mock Stream] ..."
   横幅行；gemini adapter 引用的 GoogleGenAI 在已装 SDK 中不存在，真实路径
   从未运行过。mock 输出冒充实测 + 删改输出标识，属门禁红线。返工的一切
   证据必须：原样保留完整输出、附可复现命令、注明真实/mock 模式。

1.【#27 重交】开干净分支（仅含 CI 修复，不带任何 M1/spike 内容）：
   - 把 Test step 拆成三个独立 step（rebuild:node / npm test -- --run / postinstall），
     或统一 shell: bash——现在 pwsh 多行 run 只看最后一条退出码，npm test 红
     而 postinstall 绿会假绿。
   - 开 PR 拿到真实 CI 绿灯截图/链接作为证据。这是全队 PR 转绿的前置，最优先。

2.【撤回越期与越范围内容】
   - 6e4652e（M1 domain 草稿）从 gemini/m0-spikes 撤下（revert 或摘到
     draft/gemini-m1-domain 分支）；其中 tests/unit/domain-draft.test.ts 会挂死
     vitest（你自己跑挂的进程还在），修复前不得进任何将开 PR 的分支。
   - 82b47c2 里 ~24 个越范围文件：还原对 docs/research、docs/superpowers/specs
     的 prettier 重排（他人真源，禁改）；三个 AI SDK 从 dependencies 移到
     devDependencies 或 spike 独立 package.json（.exe 体积门禁）；删掉
     pnpm-lock.yaml 与 package-lock.json 双锁并存（CI 用 npm，保 npm 锁）。
   - 回滚 tools/compose/ 转正（验收通过后才可转正）。

3.【M0-5 重做】换 @google/genai 依赖并修 functionCall/functionResponse 映射
   （name 不得硬编码 unknown_tool）；openai-compat 支持传入 model 与 base_url
   （环境变量），实测 ≥2 家国产厂商；每 adapter ≥1 模型连续 3 次稳定闭环
   （单工具/并行双工具/流式）；工具参数过 Zod；补 README + evidence/（原样
   输出）+ 六维方言矩阵（补 工具定义格式/结束条件/token 用量字段 三维）。
   真实 key 由 manpengan 以环境变量提供，仓库零落盘。

4.【M0-6 补做】按验收单补齐核心：compose 增加最小 mock server（healthcheck）
   与 Edge 占位，实现 假开单→打印(mock)→取衣 三步 HTTP/DB 往返冒烟；
   garments 组合外键补 order_id（对齐架构 §7 四元约束）；补 README（端口/
   凭据表/冷启动耗时/平台清单）+ evidence/；弱凭据加"仅限本地"注释。
   已有的 PG+RLS 角色底座质量合格，保留。

全部完成后推分支、按 §合并顺序 开 PR，等待复验。M1 的 AI Gateway 相关工作
在 M0-5 复验通过前不放行；不得再启动任何 M1 内容。
```

---

## manpengan 待办（只有你能做）

1. **API keys**：M0-5 实测需要——建议 DeepSeek + Qwen（国产两家）+ Anthropic + Gemini 各一枚，以环境变量交给 Gemini 会话（勿贴进对话正文/仓库）。
2. **实机日排期**：Grok 必修项完成后，安排三台打印机 + Windows 机（宏发现役设备）。
3. **分支保护**（仍未设）：Settings → Branches → main → Require status checks(build)。#27 合入后设置即可生效——从根上防"红灯合入"。
4. 环境残留（可顺手）：Gemini worktree 有两个挂死进程（PID 62491 vitest / 62519 esbuild）可 kill；Codex 的验证容器由其收尾指令自行清理。
