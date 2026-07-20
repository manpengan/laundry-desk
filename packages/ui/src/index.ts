/** @laundry/ui — design system (E2). Import styles: `@laundry/ui/styles.css` + `components.css`. */

export { tokens, colors, radii, shadows, fontSize, motion, spacing } from "./tokens/index.js";
export { installLiquidGlass } from "./installLiquidGlass.js";
export { cn } from "./lib/cn.js";
export {
  formatFenToYuan,
  formatMoneyFromFen,
  assertIntegerFen,
  YUAN_SIGN_UI,
} from "./lib/money.js";
export {
  resolveStatus,
  type StatusFamily,
  type StatusTone,
  type StatusShape,
  type StatusDescriptor,
} from "./lib/status.js";

export {
  Button,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
} from "./components/Button.js";
export { Input, type InputProps } from "./components/Input.js";
export { Table, type TableProps, type TableColumn } from "./components/Table.js";
export { Drawer, type DrawerProps } from "./components/Drawer.js";
export { Dialog, type DialogProps } from "./components/Dialog.js";
export {
  ToastProvider,
  ToastView,
  useToast,
  type ToastItem,
  type ToastTone,
} from "./components/Toast.js";
export { MoneyText, type MoneyTextProps, type MoneyTextSize } from "./components/MoneyText.js";
export { StatusBadge, type StatusBadgeProps } from "./components/StatusBadge.js";
