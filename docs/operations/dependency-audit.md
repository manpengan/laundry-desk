# 依赖漏洞审计门禁

运行：

```bash
pnpm install --frozen-lockfile
pnpm run workspace:audit
```

`workspace:audit` 直接读取 pnpm registry 的完整审计报告并 fail closed。任何 critical、high、
low，或未经复审的 moderate 都会失败；已复审例外只允许下列 GHSA、版本、依赖路径和
production/dev 属性。路径、版本或可达性发生变化时，门禁同样失败，不能用宽泛的包名或
severity 忽略规则放行。

当前安全版本线为 Electron `41.10.3`、Electron-Vite `4.0.1`、根 Vite `7.3.6`、Web
Vite `6.4.3`、React Router DOM `7.18.2` 与 PostCSS `8.5.23`。Electron-Vite 4/Vite 7
要求 Node `>=22.12`，仓库 engine 与 CI 的 Node 22 最新补丁线必须满足该下限。传递依赖
通过同主版本 override 固定到 `undici@7.29.0`、`fast-uri@3.1.5/4.1.2`、
`brace-expansion@1.1.18/2.1.4/5.0.9`、`js-yaml@4.3.1`、`nanoid@3.3.17`。

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
