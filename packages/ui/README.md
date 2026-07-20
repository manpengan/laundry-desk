# `@laundry/ui` — laundry-v2 设计系统（E2）

液态玻璃 tokens（v1 迁入）+ 柜台基础组件。M2 页面与 `apps/web` 统一依赖本包。

## 使用

```tsx
import "@laundry/ui/styles.css";
import "@laundry/ui/styles/components.css";
import { Button, MoneyText, StatusBadge, ToastProvider, installLiquidGlass } from "@laundry/ui";

// app bootstrap
installLiquidGlass();

function Price() {
  return <MoneyText fen={6000} />; // → ¥60.00，禁止别处手写格式化
}
```

## 组件

| 组件                         | 说明                                        |
| ---------------------------- | ------------------------------------------- |
| `Button` / `Input` / `Table` | 基础控件，触控高度 ≥44px                    |
| `Drawer` / `Dialog`          | 右侧抽屉 / 居中对话框（Esc 关闭）           |
| `ToastProvider` + `useToast` | 轻提示                                      |
| **`MoneyText`**              | **全局唯一**金额渲染（整数分→元）           |
| **`StatusBadge`**            | 状态色+形双编码（garment/order/print/sync） |

## 红线

- 金额只走 `MoneyText` / `formatMoneyFromFen`
- 状态徽章色盲安全：色 + 图形
- 文件/函数红线：≤400 行 / ≤50 行

## 开发

```bash
pnpm --filter @laundry/ui test
pnpm --filter @laundry/ui typecheck
pnpm --filter @laundry/ui build
```
