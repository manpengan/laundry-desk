# Web 生产包体积门禁

Cloud Web 与 Electron 共用的 SPA 必须按产品 surface 和柜台页面拆包。生产构建完成后，
`tools/local/web-bundle-budget.mjs` 读取真实 `dist-spa` 产物并 fail closed：

- 任一压缩前 JavaScript chunk 不得超过 500 KiB；
- `index.html` 直接加载和 modulepreload 的初始 JavaScript 合计不得超过 700 KiB；
- 全部 JavaScript 合计不得超过 1500 KiB；
- 全部 CSS 合计不得超过 160 KiB。

`@laundry/web` 的 `build` 脚本强制运行该门禁，因此根 `workspace:build`、
`workspace:check`、Edge Agent SPA 同步和 CI 均不能绕过。不能通过调高 Vite 警告阈值、
制造无意义小 chunk 或取消预算来处理超限；应优先使用 route/surface 动态导入、移除无用依赖
或缩小公共入口。

当前生产入口按 counter、owner、mobile delivery tasks、customer portal 四个 surface 加载；
counter 内部再按工作台、收衣、取衣、订单、顾客、生产、配送、提醒、统计和设置页面加载。
同步 `PageHost` 与 `CounterShell` 仍保留给 SSR 单测及公共组件 API，生产入口只使用 lazy 版本。
