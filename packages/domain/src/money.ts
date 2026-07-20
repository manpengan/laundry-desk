/**
 * @file money.ts
 * @description B1 模块：金额工具（整数分处理、格式化、折扣分摊与取整规则）
 * 遵循 GEMINI.md 红线：禁浮点数，全半角 GBK 兼容（全角 ￥ U+FFE5）。
 */

export const FULLWIDTH_YEN_SYMBOL = "\uFFE5"; // 全角 ￥，防止 GBK 编码下显示为 ?

/**
 * 校验输入必须为整数分
 */
export function validateCents(cents: number): void {
  if (!Number.isInteger(cents)) {
    throw new TypeError(`Money cents must be an integer, got: ${cents}`);
  }
}

/**
 * 将分格式化为字符串，默认带全角 ￥
 * @param cents 整数分（如 2900）
 * @param options.showSymbol 是否显示货币符号（默认 true）
 * @param options.symbol 货币符号（默认全角 ￥ U+FFE5）
 */
export function formatFen(
  cents: number,
  options?: { showSymbol?: boolean; symbol?: string },
): string {
  validateCents(cents);
  const showSymbol = options?.showSymbol ?? true;
  const symbol = options?.symbol ?? FULLWIDTH_YEN_SYMBOL;

  const isNegative = cents < 0;
  const absCents = Math.abs(cents);
  const yuanPart = Math.floor(absCents / 100);
  const fenPart = absCents % 100;

  const paddedFen = fenPart.toString().padStart(2, "0");
  const amountText = `${yuanPart}.${paddedFen}`;

  const prefix = isNegative ? "-" : "";
  const currencyPrefix = showSymbol ? symbol : "";

  return `${prefix}${currencyPrefix}${amountText}`;
}

/**
 * 将元文本或数字字符串严格解析为整数分，杜绝 29.99 * 100 浮点乘法误差
 * @param yuanStr 元文本，如 "29.00" 或 "5" 或 "0.05"
 */
export function yuanToFen(yuanStr: string | number): number {
  if (typeof yuanStr === "number") {
    if (Number.isInteger(yuanStr)) {
      yuanStr = `${yuanStr}.00`;
    } else {
      yuanStr = yuanStr.toString();
    }
  }

  const str = yuanStr.trim().replace(/^[\uFFE5\u00A5$]/, "");
  if (!str) {
    throw new Error("Invalid empty yuan string");
  }

  const match = str.match(/^(-)?(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    throw new Error(`Invalid yuan string format: "${yuanStr}"`);
  }

  const isNegative = match[1] === "-";
  const integerPart = parseInt(match[2] ?? "0", 10);
  const rawDec = match[3] ?? "0";
  const decimalPart = parseInt(rawDec.padEnd(2, "0"), 10);

  const totalCents = integerPart * 100 + decimalPart;
  return isNegative ? -totalCents : totalCents;
}

/**
 * 整数分加法
 */
export function addCents(...amounts: number[]): number {
  let sum = 0;
  for (const amt of amounts) {
    validateCents(amt);
    sum += amt;
  }
  return sum;
}

/**
 * 整数分减法
 */
export function subtractCents(a: number, b: number): number {
  validateCents(a);
  validateCents(b);
  return a - b;
}

/**
 * 按比例/折扣率计算金额并按模式取整（结果必须为整数分）
 */
export function multiplyCents(
  cents: number,
  factor: number,
  mode: "round" | "floor" | "ceil" = "round",
): number {
  validateCents(cents);
  const raw = cents * factor;
  if (mode === "round") {
    return Math.round(raw);
  } else if (mode === "floor") {
    return Math.floor(raw);
  } else {
    return Math.ceil(raw);
  }
}

/**
 * 使用最大余数法（Largest Remainder Method）对整单总折扣在多项明细之间进行精确分摊
 * 保证 sum(allocatedDiscounts) === totalDiscountCents 且没有 1 分钱浮动掉落
 *
 * @param totalDiscountCents 总优惠/折扣金额（分）
 * @param itemCentsList 各明细原始金额（分）列表
 */
export function apportionDiscount(totalDiscountCents: number, itemCentsList: number[]): number[] {
  validateCents(totalDiscountCents);
  itemCentsList.forEach(validateCents);

  if (itemCentsList.length === 0) {
    return [];
  }

  const totalItemCents = itemCentsList.reduce((acc, curr) => acc + curr, 0);
  if (totalItemCents === 0 || totalDiscountCents === 0) {
    return itemCentsList.map(() => 0);
  }

  // 1. 计算每个条目的基准精确浮点分摊额及整数下取整
  const items = itemCentsList.map((cents, index) => {
    const exact = (cents / totalItemCents) * totalDiscountCents;
    const floorVal = Math.floor(exact);
    const remainder = exact - floorVal;
    return { index, floorVal, remainder };
  });

  // 2. 统计已分配的整数金额总和
  const allocatedSum = items.reduce((acc, item) => acc + item.floorVal, 0);
  const remainingCents = totalDiscountCents - allocatedSum;

  const result = items.map((item) => item.floorVal);

  // 3. 根据余数（remainder）由大到小排序，分配剩下的剩余分
  const sortedByRemainder = [...items].sort((a, b) => b.remainder - a.remainder);

  for (let i = 0; i < remainingCents; i++) {
    const targetItem = sortedByRemainder[i % sortedByRemainder.length];
    if (targetItem) {
      result[targetItem.index] = (result[targetItem.index] ?? 0) + 1;
    }
  }

  return result;
}
