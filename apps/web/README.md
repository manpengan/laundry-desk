# `@laundry/web` — 柜台 SPA 骨架（M1）

UI spec §3 桌面壳：左侧导航 + 顶栏门店/连接状态 + 主题切换 + 工作台占位。

**未做（等契约）**：E1 登录/PIN、E3 权限路由、真实会话与 Edge 通道。

## 使用

宿主（浏览器或未来 Edge 加载的 SPA）应：

```ts
import "@laundry/ui/styles.css";
import "@laundry/ui/styles/components.css";
// shell layout classes:
import "./styles/shell.css"; // or package-relative path once bundled

import { createRoot } from "react-dom/client";
import { App } from "@laundry/web";

createRoot(document.getElementById("root")!).render(<App />);
```

M1 本包只保证 **tsc 可编译 + 组件 SSR 单测**；完整 Vite 打包进 M2 与 Edge 内置 SPA 合并。

## 开发

```bash
pnpm --filter @laundry/web test
pnpm --filter @laundry/web typecheck
```
