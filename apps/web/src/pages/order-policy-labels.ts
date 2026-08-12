import type { OrderDiscountSource } from "./order-policy-read-model.js";

export type OrderPolicyLabelInput = Readonly<{
  discount_source: OrderDiscountSource;
  discount_bps: number;
  tier?: Readonly<{ name: string }> | null;
  waivers: Readonly<{
    skip_ticket_print: boolean;
    skip_label_print: boolean;
    skip_rack_assignment: boolean;
  }>;
}>;

const WAIVER_LABELS = Object.freeze([
  Object.freeze({ key: "skip_ticket_print" as const, label: "跳过小票打印" }),
  Object.freeze({ key: "skip_label_print" as const, label: "跳过衣物标签打印" }),
  Object.freeze({ key: "skip_rack_assignment" as const, label: "跳过上挂分配" }),
]);

function discountPercent(discountBps: number): string {
  return `${(discountBps / 100)
    .toFixed(2)
    .replace(/\.00$/u, "")
    .replace(/(\.\d)0$/u, "$1")}%`;
}

export function discountPolicyLabel(policy: OrderPolicyLabelInput): string {
  if (policy.discount_source === "manual") return "人工订单折扣";
  if (policy.discount_source === "customer") {
    return policy.discount_bps === 0
      ? "顾客政策：不自动打折"
      : `顾客专属 ${discountPercent(policy.discount_bps)}`;
  }
  if (policy.discount_source === "tier") {
    return `${policy.tier?.name ?? "会员等级"} ${discountPercent(policy.discount_bps)}`;
  }
  return "无自动折扣";
}

export function waiverPolicyLabel(policy: Pick<OrderPolicyLabelInput, "waivers">): string {
  const labels = WAIVER_LABELS.filter((field) => policy.waivers[field.key]).map(
    (field) => field.label,
  );
  return labels.length === 0 ? "无" : labels.join("、");
}
