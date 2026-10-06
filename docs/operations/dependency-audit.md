# 依赖漏洞审计门禁

运行：

```bash
pnpm install --frozen-lockfile
pnpm run workspace:audit
```

`workspace:audit` 直接读取 pnpm registry 的完整审计报告并 fail closed。任何未修复的 critical、
high、low，或未经复审的 moderate 都会失败；本地安全补丁必须先完成下述完整性与行为验证，
不作为未修复 HIGH 的豁免。已复审 moderate 例外只允许下列 GHSA、版本、依赖路径和
production/dev 属性。路径、版本或可达性发生变化时，门禁同样失败，不能用宽泛的包名或
severity 忽略规则放行。

当前安全版本线为 Electron `41.10.6`、Electron-Vite `4.0.1`、根 Vite `7.3.6`、Web
Vite `6.4.3`、React Router DOM `7.18.2` 与 PostCSS `8.5.23`。Electron-Vite 4/Vite 7
要求 Node `>=22.12`，仓库 engine 与 CI 的 Node 22 最新补丁线必须满足该下限。传递依赖
通过同主版本 override 固定到 `undici@6.28.1/7.29.1`、`fast-uri@3.1.8/4.1.5`、
`brace-expansion@1.1.21/2.1.7/5.0.12`、`js-yaml@4.3.2`、`nanoid@3.3.18`。

## 2026-10-07 sharp 新公告

PR #235 的 Linux 门禁在依赖审计阶段失败，原因是一项新进入审计结果的公告，与代码改动无关；main 也同样受影响。

- [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)（HIGH）：
  - `sharp@0.35.4` 内置的 librsvg 有漏洞（CVE-2026-96889）。它是服务端的生产依赖（`apps/server → sharp`），用于照片处理和 AI 视觉。
  - npm 已发布修复版 0.35.5，直接升级服务端依赖；锁文件只有 sharp 及其各平台 `@img/*` 预编译包变化。
  - 本机复核：审计通过；涉及 sharp 的服务端照片与视觉测试 19/19 通过，载入的 librsvg 为 2.63.2。
  - Windows Runtime 发行包会带上新版 sharp，由 Windows Runtime 工作流验收。

## 2026-10-06 新增两项公告

PR #233 的 Linux 门禁在依赖审计阶段失败。原因是两项新进入审计结果的公告，与当时的代码改动无关。

- [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)（HIGH）：
  - `source-map-js@1.2.1` 的拒绝服务问题，路径经 postcss/vite/vitest，都是开发依赖。
  - npm 已发布修复版 1.2.2，用同主版本 override `source-map-js@^1.0.0 → 1.2.2` 升级。
  - 锁文件只有这一个包变化。
- [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)（moderate）：
  - `sprintf-js@1.1.3` 精度说明符无上限导致的拒绝服务。
  - 只出现在 `electron-builder → @electron/get → global-agent → roarr` 这条可选的开发依赖链上。这是打包机下载 Electron 时的代理日志，格式串由代码固定，不接收外部输入；也不进入安装包。
  - 现场查询 npm，最新版本仍是 1.1.3，修复版 1.1.4 尚未发布，所以按精确版本、路径和 dev/optional 属性登记为复审例外。
  - 1.1.4 发布后应升级并删除该例外。

## 2026-10-03 尚无上游发行版的两项安全补丁

PR #229 的 Linux 门禁被两项新进入审计结果的 HIGH 阻断。现场查询 npm registry，
最新可安装版本仍是 `http-cache-semantics@4.2.0` 和 `braces@3.0.3`；审计报告建议的
4.2.1/3.0.4 尚不可安装，GitHub 两项公告均列出 Patched versions: None。

- [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)：
  对 HTTP 缓存复用限制做本地修复，依据
  [上游问题 #56](https://github.com/kornelski/http-cache-semantics/issues/56) 与尚未合并的
  [候选修复 #58](https://github.com/kornelski/http-cache-semantics/pull/58)。
  在处理 max-stale / stale-while-revalidate 前拒绝 no-store、no-cache、共享 private、
  proxy-revalidate 及未经 public/immutable 允许的共享 Set-Cookie；保留普通过期条目的
  max-stale 行为，不把所有 maxAge=0 一律视为禁止复用。
- [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)：
  对 brace/parenthesis 解析栈以及 compile、expand、stringify 的 AST 遍历加 128 层硬限，
  深层模式和外部 AST 在耗尽调用栈前以可识别 SyntaxError 拒绝；普通 glob 与范围展开保持原语义。

补丁保存在 `patches/`，由 pnpm 的精确版本 `patchedDependencies` 与锁文件绑定。
它们不是新的上游发行版本，也不隐藏原始审计结果：命令显示 `registryHigh=2` 和两个
`locallyPatched` 标识；`high=0` 指通过验证后未修复的 HIGH 数量。

`tools/local/dependency-patch-policy.mjs` 固定完整 GHSA 元数据、原始依赖路径及 dev 属性、
补丁 SHA-256 和安装源码 SHA-256。每次审计先核对工作区声明、锁文件补丁及所有相应引用，
再沿全部允许的实际依赖链加载包，验证版本、源码及漏洞行为回归。缺文件、任意补丁改动、
未应用补丁、路径扩张、升级元数据漂移或回归失败均拒绝放行。未带验证结果的审计策略调用
也继续拒绝这两项 HIGH。

本地验证：冻结锁文件安装、审计策略与补丁 14 项测试、ESLint 均通过。Windows 原生安装
与构建验收仍跟随本批 Windows 交付执行。上游发布修复后应优先升级并删除对应补丁、
本地识别规则和补丁探针，重新采集完整审计报告；不得把该机制改成宽泛包名忽略规则。

## 2026-09-29 合并后安全依赖补充

PR #220 四项门禁通过并合入后，`main@852d198` 的 `workspace-check` 与 `real-postgres`
在依赖审计阶段失败。合并未改变已验代码树；重新采集 pnpm 审计报告发现五项新增公告，
按各依赖分支的最高修复下限补齐：

- Fast URI 固定到 `3.1.8/4.1.5`，修复
  [百分号编码导致的 host 大小写归一化不一致](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) 与
  [mailto 字段名解码导致的头注入](https://github.com/advisories/GHSA-jvvf-x445-j334)。
- brace-expansion 固定到 `1.1.21/2.1.7/5.0.12`，涵盖
  [逗号列表递归耗尽栈](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p)、
  [嵌套分组递归耗尽栈](https://github.com/advisories/GHSA-qhr7-859c-m2p7) 与
  [分组重写的平方时间复杂度](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) 三项拒绝服务公告。

仅升级五个同主版本传递依赖分支并同步锁文件；审计策略与历史例外不变。

## 2026-09-29 安全依赖更新

修复 #197 时，全量门禁被 9 月 28 日进入 GitHub Advisory Database 的
[Undici WebSocket 拒绝服务公告](https://github.com/advisories/GHSA-3wwx-pv8p-q78v) 阻断。
原主干锁定的 `@electron/get > undici@7.29.0` 与
`electron-builder > app-builder-lib > @electron/rebuild > node-gyp > undici@6.28.0`
均在受影响范围内。两个同主版本 override 分别固定到修复版 `7.29.1` 与 `6.28.1`。

完整审计还发现当前 Fast URI 与 Electron 版本受到新增公告影响，按同主版本修复下限更新：

- Fast URI 固定到 `3.1.7/4.1.4`，修复
  [非法端口导致的 authority 注入](https://github.com/advisories/GHSA-qw65-cvwx-89v3) 与
  [未闭合括号导致的 host 解析混淆](https://github.com/advisories/GHSA-58mr-gqgx-xq4g)。
- 根与 Edge Agent 的 Electron 统一到 `41.10.6`，涵盖审计发现的五项新增公告，包含
  [新窗口未继承 sandbox 限制](https://github.com/advisories/GHSA-gr2m-v5gq-v685)。

只更新依赖补丁版本与对应锁定测试；审计策略与历史例外不变。

## 2026-09-10 安全依赖更新

9 月 6 日定时 CI 首先被
[Browserslist 公告](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) 阻断；重新采集完整审计后，
同步修复当前依赖图内其余未获豁免的公告。按修复下限固定版本：

- Server：Fastify `5.12.1`、Sharp `0.35.4`；
- 传递依赖：Browserslist `4.28.7`、baseline-browser-mapping `2.11.0`、
  fast-uri `3.1.6/4.1.3`、js-yaml `4.3.2`、@xmldom/xmldom `0.8.15/0.9.12`；
- 测试工具：Vitest 与 coverage-v8 统一 `4.1.11`，修复
  [mocker 文件读取公告](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)。Contracts 移除 v4
  不再支持的 `coverage.all`，保留显式 `src/**/*.ts` include 与原有覆盖率阈值。

更新不增加审计例外，不放宽 severity、依赖路径或版本校验。已获复审的两个历史例外继续如下。

## 当前临时例外

| GHSA                                       | 当前路径                                                                                       | 不可达理由                                                                                                                                                  | 移除条件                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `GHSA-67mh-4wv8-2f99` (`esbuild@0.18.20`)  | `drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils > esbuild`，仅 dev dependency | 公告针对可被浏览器访问的 esbuild 开发服务器；锁定的 `core-utils` 源码只调用 `transform/transformSync`，项目也只把它用于 Drizzle CLI，不启动或暴露开发服务器 | Drizzle 移除旧 `@esbuild-kit` 链或升级到 `esbuild >=0.24.3` |
| `GHSA-w5hq-g745-h8pq` (`uuid@8.3.2/9.0.1`) | `exceljs > uuid`、`tencentcloud-sdk-nodejs-sms > common > uuid`                                | 公告只影响 v3/v5/v6 在调用方传入输出 buffer 时的边界检查；锁定的两个上游都只调用无参数 `v4()`，应用也不直接依赖或调用 `uuid`                                | ExcelJS 与腾讯云 SDK 升级到使用 `uuid >=11.1.1` 的版本      |

例外真源位于 `tools/local/dependency-audit.mjs`，回归测试会验证：

- 新增 advisory 一律失败；
- 已允许 GHSA 的 severity、修复范围或包名变化失败；
- 新增依赖路径、版本、production/dev/optional/bundled 属性变化失败；
- 上游逐步修复并使例外路径减少或清零时继续通过。

例外只描述当前依赖图，不代表接受新的同类风险。每次修改例外都必须附新的可达性分析和
定向测试。
