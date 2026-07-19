import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 格式化金额（分转元）
 */
export function formatCurrency(cents: number) {
  return (cents / 100).toLocaleString("zh-CN", {
    style: "currency",
    currency: "CNY",
  });
}
