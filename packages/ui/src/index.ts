/** @laundry/ui — design system (E2). Import styles: `@laundry/ui/styles.css` + `components.css`. */

export { tokens, colors, radii, shadows, fontSize, motion, spacing } from "./tokens/index.js";
export { installLiquidGlass } from "./installLiquidGlass.js";
export { AuroraBackdrop } from "./components/AuroraBackdrop.js";
export {
  useMagneticIndicator,
  flipStartTransform,
  restingTransform,
  sameBox,
  type IndicatorBox,
} from "./lib/magnetic-indicator.js";
export { useCountUp, countUpValue, easeOutCubic, type CountUpOptions } from "./lib/count-up.js";
export { cn } from "./lib/cn.js";
export {
  formatFenToYuan,
  formatMoneyFromFen,
  assertIntegerFen,
  parseYuanToFen,
  type ParsedYuan,
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
export { MoneyInput, type MoneyInputProps } from "./components/MoneyInput.js";
export { Table, type TableProps, type TableColumn } from "./components/Table.js";
export { Drawer, type DrawerProps } from "./components/Drawer.js";
export { Dialog, type DialogProps } from "./components/Dialog.js";
export {
  ToastProvider,
  ToastView,
  useToast,
  useToastPageScope,
  type ToastItem,
  type ToastTone,
} from "./components/Toast.js";
export { MoneyText, type MoneyTextProps, type MoneyTextSize } from "./components/MoneyText.js";
export { StatusBadge, type StatusBadgeProps } from "./components/StatusBadge.js";
export { Skeleton, type SkeletonProps } from "./components/Skeleton.js";
export { EmptyState, type EmptyStateProps } from "./components/EmptyState.js";
export {
  SyncStatusBar,
  formatSyncLabel,
  formatSyncDetail,
  type SyncStatusBarProps,
} from "./components/SyncStatusBar.js";
export {
  PrintJobIndicator,
  printIndicatorLabel,
  printIndicatorStatus,
  type PrintJobIndicatorProps,
  type PrintJobSummary,
} from "./components/PrintJobIndicator.js";
export { Icon, ICON_NAMES, type IconName, type IconProps } from "./components/Icon.js";
export { Tabs, nextEnabledIndex, type TabItem, type TabsProps } from "./components/Tabs.js";
export {
  Banner,
  Kbd,
  type BannerProps,
  type BannerTone,
  type KbdProps,
} from "./components/Feedback.js";
export {
  NumberPad,
  applyNumberPadKey,
  type NumberPadKey,
  type NumberPadProps,
} from "./components/NumberPad.js";
export { MaskedPhone, maskPhone, type MaskedPhoneProps } from "./components/MaskedPhone.js";
export {
  useFocusTrap,
  wrapFocusIndex,
  pickInitialFocus,
  FOCUSABLE_SELECTOR,
} from "./lib/focus-trap.js";
