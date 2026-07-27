# `@laundry/web` — 柜台 SPA 骨架（M1）

UI spec §3 桌面壳：登录 → 左侧导航 + 顶栏门店/连接状态 + 主题切换 + 工作台占位。

**已交付（骨架）**：

- 登录页（org_code / store_code / username / password）
- 可注入 `AuthClient` 端口（默认 mock：密码 `demo`，PIN `1234`）
- Access session **仅内存**（React state），不写 localStorage / sessionStorage
- 顶栏「切换员工」→ PIN quick-switch dialog（`purpose: quick_switch`）
- 连接状态条（SyncStatusBar）在已登录壳内展示
- **M2 开单 / 取衣**：`ReceivePage` / `PickupPage` → `order.receive` / `order.pickup`（整数分）
- **统一取衣检索**：票号、取件码、衣物条码、手机号或姓名前缀 → 受限的 `order.lookup` 候选集
- **独立收款 / 补缴**：付款方式与备注 → `payment.collect` / `payment.repay` 的只追加账本流水
- 设置页 R5 step-up PIN 复核 demo

**未做**：完整价目字典 UI、A7 OpenAPI 生成客户端。

## 使用

宿主（浏览器或未来 Edge 加载的 SPA）应：

```ts
import "@laundry/ui/styles.css";
import "@laundry/ui/styles/components.css";
import "./styles/shell.css";

import { createRoot } from "react-dom/client";
import { App, createMockAuthClient } from "@laundry/web";

createRoot(document.getElementById("root")!).render(
  <App authClient={createMockAuthClient()} />,
);
```

Mock 登录：任意机构/门店/用户名 + 密码 `demo`。PIN 快切：`1234`。

## 开发

```bash
pnpm --filter @laundry/web test
pnpm --filter @laundry/web typecheck
```
